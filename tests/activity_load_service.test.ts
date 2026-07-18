// Exercises the real computeAndStoreActivityLoad against a live DB, driving
// stream input by monkeypatching the (globally mocked) stravaApiService object
// (the strava_dedup.test.ts pattern) — no mock.module, so nothing leaks.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { updateUserSettings } from "../src/repositories/user_settings_repository";
import { activities } from "../src/schema";
import { computeAndStoreActivityLoad } from "../src/services/activity_load_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

const db = getDb();

function constantRun(velocityMps: number, seconds: number) {
  const time: number[] = [];
  const velocity_smooth: number[] = [];
  for (let i = 0; i <= seconds; i++) {
    time.push(i);
    velocity_smooth.push(velocityMps);
  }
  return { time: { data: time }, velocity_smooth: { data: velocity_smooth } };
}

const realGetActivityStreams = stravaApiService.getActivityStreams;
let streamResult: unknown = {};
let streamsShouldThrow = false;

function patchStreams() {
  stravaApiService.getActivityStreams = (async () => {
    if (streamsShouldThrow) throw new Error("strava streams down");
    return streamResult;
  }) as typeof stravaApiService.getActivityStreams;
}

afterEach(() => {
  stravaApiService.getActivityStreams = realGetActivityStreams;
  streamResult = {};
  streamsShouldThrow = false;
});

afterAll(async () => {
  await closePool();
});

describe("computeAndStoreActivityLoad", () => {
  it("computes and persists load + source on the happy path", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await updateUserSettings(db, user.id, { thresholdPaceMps: 3.5 });
      const act = await insertActivity(user.id, { sportType: "Run" });
      streamResult = constantRun(4.0, 60);
      patchStreams();

      const result = await computeAndStoreActivityLoad(db, user.id, act.id);
      expect(result).not.toBeNull();
      expect(result?.source).toBe("pace");
      expect(result?.load).toBeGreaterThan(0);

      const [row] = await db
        .select({ load: activities.trainingLoad, source: activities.trainingLoadSource })
        .from(activities)
        .where(eq(activities.id, act.id));
      expect(row.load).toBe(result?.load ?? null);
      expect(row.source).toBe("pace");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("leaves an existing value intact when the computation yields null", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      // No thresholds configured → pace/power/hr all unavailable → null result.
      const act = await insertActivity(user.id, { sportType: "Run" });
      await db
        .update(activities)
        .set({ trainingLoad: 42, trainingLoadSource: "hr" })
        .where(eq(activities.id, act.id));
      streamResult = constantRun(4.0, 60);
      patchStreams();

      const result = await computeAndStoreActivityLoad(db, user.id, act.id);
      expect(result).toBeNull();

      const [row] = await db
        .select({ load: activities.trainingLoad, source: activities.trainingLoadSource })
        .from(activities)
        .where(eq(activities.id, act.id));
      expect(row.load).toBe(42);
      expect(row.source).toBe("hr");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("leaves an existing value intact and does not throw when stream fetch fails", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await updateUserSettings(db, user.id, { thresholdPaceMps: 3.5 });
      const act = await insertActivity(user.id, { sportType: "Run" });
      await db
        .update(activities)
        .set({ trainingLoad: 77, trainingLoadSource: "power" })
        .where(eq(activities.id, act.id));
      streamsShouldThrow = true;
      patchStreams();

      const result = await computeAndStoreActivityLoad(db, user.id, act.id);
      expect(result).toBeNull();

      const [row] = await db
        .select({ load: activities.trainingLoad, source: activities.trainingLoadSource })
        .from(activities)
        .where(eq(activities.id, act.id));
      expect(row.load).toBe(77);
      expect(row.source).toBe("power");
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
