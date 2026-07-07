import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { existingStravaIdsForUser } from "../src/repositories/activity_repository";
import { activities } from "../src/schema";
import { stravaApiService } from "../src/services/strava_api_service";
import { syncAllFromStrava } from "../src/services/strava_link_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Monkeypatch only the two Strava API methods syncAllFromStrava touches, and
// restore them after each test — avoids mock.module, which leaks across files.
let restore: Array<() => void> = [];
const mockState: { summaries: unknown[] } = { summaries: [] };

function patch<K extends keyof typeof stravaApiService>(key: K, impl: (typeof stravaApiService)[K]) {
  const original = stravaApiService[key];
  stravaApiService[key] = impl;
  restore.push(() => {
    stravaApiService[key] = original;
  });
}

let user: { id: string; clerkId: string };

beforeEach(async () => {
  user = await createTestUser({ role: "premium" });
  mockState.summaries = [];
  patch("listAthleteActivitiesWithMeta", (async () => ({
    data: mockState.summaries,
    rateLimit: null,
  })) as typeof stravaApiService.listAthleteActivitiesWithMeta);
  patch("getActivityWithMeta", (async () => ({
    data: { description: "" },
    rateLimit: null,
  })) as unknown as typeof stravaApiService.getActivityWithMeta);
});

afterEach(async () => {
  for (const r of restore) r();
  restore = [];
  await deleteTestUser(user.id);
});

afterAll(async () => {
  await closePool();
});

async function insertIntervalsRow(over: {
  intervalsStravaId?: number | null;
  intervalsIcuId?: string;
  distance?: number;
  startDateLocal?: Date;
}) {
  const [row] = await getDb()
    .insert(activities)
    .values({
      userId: user.id,
      stravaActivityId: null,
      intervalsStravaId: over.intervalsStravaId ?? null,
      intervalsIcuId: over.intervalsIcuId ?? `i-${Math.random().toString(36).slice(2)}`,
      title: "Intervals import",
      sportType: "VirtualRun",
      distance: over.distance ?? 6000,
      movingTime: 1500,
      startDateLocal: over.startDateLocal ?? new Date("2026-05-01T08:00:00Z"),
      indoor: true,
      analysisStatus: "completed",
    })
    .returning();
  return row;
}

const summary = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: "Morning Run",
  sport_type: "Run",
  type: "Run",
  distance: 9999,
  moving_time: 1800,
  total_elevation_gain: 0,
  average_heartrate: null,
  max_heartrate: null,
  start_date_local: "2026-06-01T07:00:00Z",
  has_heartrate: false,
  gear_id: null,
  trainer: false,
  ...over,
});

describe("Strava bulk sync dedup (intervalsStravaId exact join)", () => {
  it("links an intervals-sourced row by intervalsStravaId when fuzzy time/distance miss", async () => {
    // distance + start are wildly different, so the fuzzy matcher cannot link;
    // only the exact intervalsStravaId join can.
    await insertIntervalsRow({
      intervalsStravaId: 222333,
      distance: 1,
      startDateLocal: new Date("2020-01-01T00:00:00Z"),
    });
    mockState.summaries = [summary(222333)];

    const result = await syncAllFromStrava({ db: getDb() } as never, "tok", { id: user.id });

    expect(result.linked).toBe(1);
    expect(result.created).toBe(0);
    const rows = await getDb().select().from(activities).where(eq(activities.userId, user.id));
    expect(rows).toHaveLength(1); // linked, not duplicated
    expect(rows[0].stravaActivityId).toBe(222333);
    expect(rows[0].intervalsIcuId).not.toBeNull();
  });

  it("inserts a new row when no intervals-sourced row carries the Strava id", async () => {
    await insertIntervalsRow({ intervalsStravaId: null, distance: 1 });
    mockState.summaries = [summary(444555, { distance: 12345 })];

    const result = await syncAllFromStrava({ db: getDb() } as never, "tok", { id: user.id });

    expect(result.linked).toBe(0);
    expect(result.created).toBe(1);
    const rows = await getDb().select().from(activities).where(eq(activities.userId, user.id));
    expect(rows).toHaveLength(2); // the import + the new Strava row (no false dedup)
  });
});

async function insertStravaRow(stravaActivityId: number) {
  const [row] = await getDb()
    .insert(activities)
    .values({
      userId: user.id,
      stravaActivityId,
      title: "Strava Run",
      sportType: "Run",
      distance: 5000,
      movingTime: 1500,
      startDateLocal: new Date("2026-04-01T07:00:00Z"),
      indoor: false,
      analysisStatus: "completed",
    })
    .returning();
  return row;
}

describe("existingStravaIdsForUser (load-list dedup helper)", () => {
  it("returns an empty set for no candidate ids (no query)", async () => {
    const present = await existingStravaIdsForUser(getDb(), user.id, []);
    expect(present.size).toBe(0);
  });

  it("flags ids present as Strava-sourced rows (stravaActivityId)", async () => {
    await insertStravaRow(111);
    const present = await existingStravaIdsForUser(getDb(), user.id, [111, 222]);
    expect([...present].sort()).toEqual([111]);
  });

  it("flags ids present only as intervals.icu twins (intervalsStravaId)", async () => {
    // The key gap: an intervals-sourced row carries the Strava id in
    // intervalsStravaId with stravaActivityId = null. It must still count as
    // already-present so the Strava load doesn't offer it for re-import.
    await insertIntervalsRow({ intervalsStravaId: 333 });
    const present = await existingStravaIdsForUser(getDb(), user.id, [333, 444]);
    expect([...present].sort()).toEqual([333]);
  });

  it("flags ids present via either column and ignores absent ids", async () => {
    await insertStravaRow(111);
    await insertIntervalsRow({ intervalsStravaId: 333 });
    const present = await existingStravaIdsForUser(getDb(), user.id, [111, 333, 999]);
    expect([...present].sort((a, b) => a - b)).toEqual([111, 333]);
    expect(present.has(999)).toBe(false);
  });

  it("does not match another user's activities", async () => {
    const other = await createTestUser({ role: "premium" });
    await getDb()
      .insert(activities)
      .values({
        userId: other.id,
        stravaActivityId: 777,
        title: "Other user run",
        sportType: "Run",
        distance: 5000,
        movingTime: 1500,
        startDateLocal: new Date("2026-04-01T07:00:00Z"),
        indoor: false,
        analysisStatus: "completed",
      });
    const present = await existingStravaIdsForUser(getDb(), user.id, [777]);
    expect(present.has(777)).toBe(false);
    await deleteTestUser(other.id);
  });
});

// NOTE: the import path (`stravaApiService.syncStravaActivities`) converges with
// an intervals.icu twin (by `intervalsStravaId`) instead of inserting a Strava
// duplicate, and stays idempotent on re-import via `onConflictDoNothing`. It is
// NOT unit-tested here because `tests/setup.ts` `mock.module`s the whole
// `strava_api_service` to a stub, so the real method can't be exercised in this
// suite. Verified manually against the dev DB (merge → 1 row, intervalsIcuId
// preserved, status re-armed to `pending`; double-import → 1 row).
