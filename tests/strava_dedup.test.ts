import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
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
  })) as typeof stravaApiService.getActivityWithMeta);
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
