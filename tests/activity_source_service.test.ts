import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { AppError } from "../src/error";
import { activities } from "../src/schema";
import { getLaps, getStreamSet } from "../src/services/activity_source_service";
import { intervalsApiService } from "../src/services/intervals_api_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Monkeypatch the two API-service objects (leak-safe, restored after each test —
// unlike mock.module) and drive row/consent/token resolution through the real
// test DB seeded by createTestUser.
let restore: Array<() => void> = [];
function patch<T, K extends keyof T>(obj: T, key: K, impl: T[K]) {
  const original = obj[key];
  obj[key] = impl;
  restore.push(() => {
    obj[key] = original;
  });
}

afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const STREAM_KEYS = [
  "time",
  "distance",
  "altitude",
  "cadence",
  "velocity_smooth",
  "heartrate",
] as const;

// intervals.icu raw stream array: latlng split into data/data2, moving numeric.
const intervalsRaw = [
  { type: "time", data: [0, 1, 2] },
  { type: "distance", data: [0, 5, 10] },
  { type: "heartrate", data: [100, 110, 120] },
  { type: "latlng", data: [1, 2], data2: [3, 4] },
  { type: "moving", data: [1, 0, 1] },
];

const stravaStreamSet = {
  time: { data: [0, 1] },
  distance: { data: [0, 5] },
  heartrate: { data: [100, 110] },
};

let consentUser: { id: string; clerkId: string };
let noConsentUser: { id: string; clerkId: string };
const activityIds: number[] = [];

async function seedActivity(
  userId: string,
  opts: { intervalsIcuId?: string | null; stravaActivityId?: number | null },
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .insert(activities)
    .values({
      userId,
      stravaActivityId:
        opts.stravaActivityId === undefined
          ? Math.floor(Math.random() * 1e12)
          : opts.stravaActivityId,
      intervalsIcuId: opts.intervalsIcuId ?? null,
      title: "source test",
      sportType: "Run",
      distance: 5000,
      movingTime: 1500,
      startDateLocal: new Date(),
      analysisStatus: "completed",
      trainingType: "EASY",
      indoor: false,
    })
    .returning();
  activityIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  consentUser = await createTestUser({ role: "premium", processHeartRate: true });
  noConsentUser = await createTestUser({ role: "premium", processHeartRate: false });
});

afterAll(async () => {
  await deleteTestUser(consentUser.id);
  await deleteTestUser(noConsentUser.id);
  await closePool();
});

describe("getStreamSet dispatch + consent", () => {
  it("fetches from intervals.icu and maps latlng/moving; Strava is never called", async () => {
    let stravaCalled = false;
    let intervalsKeys: readonly unknown[] = [];
    patch(intervalsApiService, "getActivityStreams", (async (_t, _id, keys) => {
      intervalsKeys = keys;
      return intervalsRaw;
    }) as typeof intervalsApiService.getActivityStreams);
    patch(stravaApiService, "getActivityStreams", (async () => {
      stravaCalled = true;
      return {};
    }) as typeof stravaApiService.getActivityStreams);

    const id = await seedActivity(consentUser.id, { intervalsIcuId: "icu-1" });
    const streams = await getStreamSet(getDb(), consentUser.id, id, [...STREAM_KEYS]);

    expect(stravaCalled).toBe(false);
    expect(intervalsKeys).toContain("heartrate");
    expect(streams.latlng?.data).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(streams.moving?.data).toEqual([true, false, true]);
    expect(streams.heartrate?.data).toEqual([100, 110, 120]);
  });

  it("falls back to Strava for the whole call when the intervals fetch throws", async () => {
    let stravaCalled = false;
    patch(intervalsApiService, "getActivityStreams", (async () => {
      throw new Error("intervals 500");
    }) as typeof intervalsApiService.getActivityStreams);
    patch(stravaApiService, "getActivityStreams", (async () => {
      stravaCalled = true;
      return stravaStreamSet;
    }) as typeof stravaApiService.getActivityStreams);

    const id = await seedActivity(consentUser.id, {
      intervalsIcuId: "icu-2",
      stravaActivityId: 555,
    });
    const streams = await getStreamSet(getDb(), consentUser.id, id, [...STREAM_KEYS]);

    expect(stravaCalled).toBe(true);
    expect(streams.time?.data).toEqual([0, 1]);
  });

  it("goes straight to Strava when there is no intervals.icu id", async () => {
    let intervalsCalled = false;
    patch(intervalsApiService, "getActivityStreams", (async () => {
      intervalsCalled = true;
      return intervalsRaw;
    }) as typeof intervalsApiService.getActivityStreams);
    patch(stravaApiService, "getActivityStreams", (async () =>
      stravaStreamSet) as typeof stravaApiService.getActivityStreams);

    const id = await seedActivity(consentUser.id, { intervalsIcuId: null, stravaActivityId: 777 });
    const streams = await getStreamSet(getDb(), consentUser.id, id, [...STREAM_KEYS]);

    expect(intervalsCalled).toBe(false);
    expect(streams.distance?.data).toEqual([0, 5]);
  });

  it("throws AppError when the activity has neither source id", async () => {
    const id = await seedActivity(consentUser.id, {
      intervalsIcuId: null,
      stravaActivityId: null,
    });
    await expect(getStreamSet(getDb(), consentUser.id, id, [...STREAM_KEYS])).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("drops heartrate from the fetch and result when the user has no consent", async () => {
    let seenKeys: readonly unknown[] = [];
    patch(intervalsApiService, "getActivityStreams", (async (_t, _id, keys) => {
      seenKeys = keys;
      return intervalsRaw;
    }) as typeof intervalsApiService.getActivityStreams);

    const id = await seedActivity(noConsentUser.id, { intervalsIcuId: "icu-3" });
    const streams = await getStreamSet(getDb(), noConsentUser.id, id, [...STREAM_KEYS]);

    expect(seenKeys).not.toContain("heartrate");
    expect(streams.heartrate).toBeUndefined();
  });

  it("keeps heartrate in the fetch when the user has consent", async () => {
    let seenKeys: readonly unknown[] = [];
    patch(intervalsApiService, "getActivityStreams", (async (_t, _id, keys) => {
      seenKeys = keys;
      return intervalsRaw;
    }) as typeof intervalsApiService.getActivityStreams);

    const id = await seedActivity(consentUser.id, { intervalsIcuId: "icu-4" });
    await getStreamSet(getDb(), consentUser.id, id, [...STREAM_KEYS]);

    expect(seenKeys).toContain("heartrate");
  });
});

describe("getLaps dispatch mirrors getStreamSet", () => {
  it("fetches laps from intervals.icu when available", async () => {
    let stravaLapsCalled = false;
    patch(intervalsApiService, "getActivityIntervals", (async () => ({
      icu_intervals: [{ id: 1, distance: 100, moving_time: 30, start_index: 0, end_index: 2 }],
    })) as typeof intervalsApiService.getActivityIntervals);
    patch(stravaApiService, "getActivityLaps", (async () => {
      stravaLapsCalled = true;
      return [];
    }) as typeof stravaApiService.getActivityLaps);

    const id = await seedActivity(consentUser.id, { intervalsIcuId: "icu-laps-1" });
    const laps = await getLaps(getDb(), consentUser.id, id);

    expect(stravaLapsCalled).toBe(false);
    expect(laps).toHaveLength(1);
    expect(laps[0].distance).toBe(100);
  });

  it("falls back to Strava laps when the intervals fetch throws", async () => {
    let stravaLapsCalled = false;
    patch(intervalsApiService, "getActivityIntervals", (async () => {
      throw new Error("intervals laps 500");
    }) as typeof intervalsApiService.getActivityIntervals);
    patch(stravaApiService, "getActivityLaps", (async () => {
      stravaLapsCalled = true;
      return [];
    }) as typeof stravaApiService.getActivityLaps);

    const id = await seedActivity(consentUser.id, {
      intervalsIcuId: "icu-laps-2",
      stravaActivityId: 888,
    });
    await getLaps(getDb(), consentUser.id, id);

    expect(stravaLapsCalled).toBe(true);
  });
});
