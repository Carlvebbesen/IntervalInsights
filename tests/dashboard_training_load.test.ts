// Verifies getTrainingSummary coalesces self-computed trainingLoad ahead of the
// intervals.icu value (COALESCE(trainingLoad, icuTrainingLoad) convention).
//
// intervals_wellness_service is globally stubbed to "not_linked" in setup.ts;
// this file re-stubs fetchTrainingSummary to "ok" so the todaySessions branch
// runs, then restores the not_linked default in afterAll so nothing leaks.

import { afterAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { getTrainingSummary } from "../src/controllers/dashboard_controller";
import { activities } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

mock.module("../src/services/intervals_wellness_service.ts", () => ({
  fetchWellnessSummary: async () => null,
  fetchTrainingSummary: async () => ({ status: "ok", data: {} }),
  fetchWellnessSeries: async () => ({ status: "not_linked", data: null }),
  fetchWeekWellnessStats: async () => null,
}));

const db = getDb();

afterAll(async () => {
  mock.module("../src/services/intervals_wellness_service.ts", () => ({
    fetchWellnessSummary: async () => null,
    fetchTrainingSummary: async () => ({ status: "not_linked", data: null }),
    fetchWellnessSeries: async () => ({ status: "not_linked", data: null }),
    fetchWeekWellnessStats: async () => null,
  }));
  await closePool();
});

describe("getTrainingSummary load precedence", () => {
  it("prefers the self-computed trainingLoad over icuTrainingLoad when both exist", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const act = await insertActivity(user.id, {
        sportType: "Run",
        startDateLocal: new Date("2026-06-15T10:00:00Z"),
      });
      await db
        .update(activities)
        .set({ trainingLoad: 50, icuTrainingLoad: 200 })
        .where(eq(activities.id, act.id));

      const summary = await getTrainingSummary(db, user.id, "2026-06-15");
      expect(summary.status).toBe("ok");
      if (summary.status !== "ok") return;
      expect(summary.data.todaySessions).toHaveLength(1);
      expect(summary.data.todaySessions[0].load).toBe(50);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
