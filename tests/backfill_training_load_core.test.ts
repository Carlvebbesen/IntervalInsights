import { afterAll, describe, expect, it } from "bun:test";
import { type BackfillCounts, backfillUserLoads } from "../scripts/_backfill_training_load_core";
import { activities } from "../src/schema";
import type { ResolvedThresholds } from "../src/services/threshold_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

const THRESHOLDS: ResolvedThresholds = {
  thresholdPaceMps: 4,
  thresholdPaceSource: "manual",
  lthr: 170,
  restingHr: 45,
  maxHr: 195,
  ftp: null,
  sex: null,
};

async function insertActivity(userId: string, startDateLocal: Date, trainingLoad: number | null) {
  const db = getDb();
  const [row] = await db
    .insert(activities)
    .values({
      userId,
      stravaActivityId: Math.floor(Math.random() * 1e12),
      title: "backfill core test",
      sportType: "Run",
      distance: 10000,
      movingTime: 3000,
      startDateLocal,
      indoor: false,
      trainingLoad,
    })
    .returning({ id: activities.id });
  return row.id;
}

describe("backfillUserLoads loop invariants", () => {
  it("skips already-computed rows at the query level, walks oldest-first, and continues past per-activity errors", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      const oldest = await insertActivity(user.id, new Date("2020-01-01T10:00:00"), null);
      const precomputed = await insertActivity(user.id, new Date("2020-02-01T10:00:00"), 55);
      const failing = await insertActivity(user.id, new Date("2020-03-01T10:00:00"), null);
      const newest = await insertActivity(user.id, new Date("2020-04-01T10:00:00"), null);

      const seen: number[] = [];
      const counts: BackfillCounts = { success: 0, skipped: 0, failed: 0 };
      await backfillUserLoads(db, user.id, async () => THRESHOLDS, counts, {
        dryRun: false,
        computeFn: async (_db, _userId, activityId) => {
          seen.push(activityId);
          if (activityId === failing) throw new Error("stream fetch exploded");
          if (activityId === newest) return null;
          return { load: 42, source: "pace" };
        },
      });

      expect(seen).toEqual([oldest, failing, newest]); // precomputed excluded, date order
      expect(counts).toEqual({ success: 1, skipped: 1, failed: 1 });
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("dry-run flag reaches the compute step and reports results via onResult", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      const id = await insertActivity(user.id, new Date("2021-05-01T10:00:00"), null);

      const dryRunsSeen: boolean[] = [];
      const reported: Array<{ activityId: number; load: number }> = [];
      const counts: BackfillCounts = { success: 0, skipped: 0, failed: 0 };
      await backfillUserLoads(db, user.id, async () => THRESHOLDS, counts, {
        dryRun: true,
        computeFn: async (_db, _userId, _activityId, _thresholds, opts) => {
          dryRunsSeen.push(opts?.dryRun === true);
          return { load: 77, source: "hr" };
        },
        onResult: (activityId, r) => reported.push({ activityId, load: r.load }),
      });

      expect(dryRunsSeen).toEqual([true]);
      expect(reported).toEqual([{ activityId: id, load: 77 }]);
      expect(counts.success).toBe(1);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("resolves thresholds as-of each activity's own start date", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const db = getDb();
      await insertActivity(user.id, new Date("2019-06-01T10:00:00"), null);
      await insertActivity(user.id, new Date("2023-06-01T10:00:00"), null);

      const asOfDates: string[] = [];
      const counts: BackfillCounts = { success: 0, skipped: 0, failed: 0 };
      await backfillUserLoads(
        db,
        user.id,
        async (asOf) => {
          asOfDates.push(asOf.toISOString().slice(0, 10));
          return THRESHOLDS;
        },
        counts,
        { dryRun: true, computeFn: async () => null },
      );

      expect(asOfDates).toEqual(["2019-06-01", "2023-06-01"]);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
