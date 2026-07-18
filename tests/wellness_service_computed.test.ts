// REAL intervals_wellness_service tests (self-computed fitness swap, wave 2).
// Runs under tests/bunfig.fitness.toml (setup.fitness.ts) so the service is
// UNMOCKED; wellness records are driven through `wellnessStub`. See that setup
// file for why this needs a dedicated preload.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  fetchTrainingSummary,
  fetchWeekWellnessStats,
  fetchWellnessSeries,
  fetchWellnessSummary,
} from "../src/services/intervals_wellness_service";
import { activities } from "../src/schema";
import type { IIntervalsWellness } from "../src/types/intervals/IIntervalsWellness";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { wellnessStub } from "./helpers/wellness_stub";

const db = getDb();

// Meaningful ONLY under the dedicated preload (tests/setup.fitness.ts, via
// `bun run test:fitness`) where intervals_wellness_service is REAL. The default
// `bun run test` also discovers this file but runs it under the mocking preload;
// there we detect the stub and SKIP (mirrors tests/pace_service.test.ts).
const REAL = fetchTrainingSummary.toString().includes("metricsPoint");
const suite = REAL ? describe : describe.skip;

if (!REAL) {
  describe.skip("wellness_service_computed.test.ts (mocked — run `bun run test:fitness`)", () => {
    it.skip("see scripts/test-fitness.sh + tests/bunfig.fitness.toml", () => {});
  });
}

async function seedLoad(
  userId: string,
  opts: { day: string; sport?: string; trainingLoad?: number },
): Promise<void> {
  await db.insert(activities).values({
    userId,
    stravaActivityId: Math.floor(Math.random() * 1e12),
    title: "t",
    sportType: opts.sport ?? "Run",
    distance: 5000,
    movingTime: 1500,
    startDateLocal: new Date(`${opts.day}T12:00:00`),
    indoor: false,
    trainingLoad: opts.trainingLoad ?? 60,
  });
}

function wellness(id: string, overrides: Partial<IIntervalsWellness>): Partial<IIntervalsWellness> {
  return { id, ...overrides };
}

afterEach(() => wellnessStub.reset());
afterAll(async () => {
  await closePool();
});

suite("fetchTrainingSummary (computed)", () => {
  it("serves computed fitness with null data points for a Strava-only user", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 90 });
      const res = await fetchTrainingSummary(db, user.id, "2026-05-05");
      expect(res.status).toBe("ok");
      if (res.status !== "ok") return;
      expect(typeof res.data.fitness.ctl).toBe("number");
      expect(res.data.fitness.ctl).toBeGreaterThan(0);
      expect(res.data.date).toBe("2026-05-05");
      // No provider data → data points null.
      expect(res.data.recovery.hrv).toBeNull();
      expect(res.data.body.vo2max).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns not_linked only when there is no provider AND no activities", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      const res = await fetchTrainingSummary(db, user.id, "2026-05-05");
      expect(res.status).toBe("not_linked");
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("uses computed ctl/atl (not wellness passthrough) and merges data points when linked", async () => {
    const user = await createTestUser({ role: "premium", intervals: true });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 90 });
      wellnessStub.records = [
        wellness("2026-05-05", { ctl: 999, atl: 999, hrv: 61, vo2max: 54, restingHR: 44 }),
      ];
      const res = await fetchTrainingSummary(db, user.id, "2026-05-05");
      expect(res.status).toBe("ok");
      if (res.status !== "ok") return;
      expect(res.data.fitness.ctl).not.toBe(999);
      expect(res.data.fitness.ctl).toBeLessThan(50);
      expect(res.data.recovery.hrv).toBe(61);
      expect(res.data.body.vo2max).toBe(54);
      expect(res.data.recovery.restingHR).toBe(44);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

suite("fetchWellnessSummary (computed ctl/atl/tsb)", () => {
  it("computes ctl/atl/tsb and reads avgHrv/restingHr from wellness", async () => {
    const user = await createTestUser({ role: "premium", intervals: true });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 90 });
      wellnessStub.records = [
        wellness("2026-05-04", { ctl: 999, atl: 999, hrv: 50 }),
        wellness("2026-05-05", { ctl: 999, atl: 999, hrv: 70, restingHR: 40 }),
      ];
      const res = await fetchWellnessSummary(db, user.id, "2026-05-01", "2026-05-05");
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.ctl).not.toBe(999);
      expect(typeof res.ctl).toBe("number");
      expect(res.tsb).toBeCloseTo((res.ctl ?? 0) - (res.atl ?? 0), 6);
      expect(res.avgHrv).toBe(60); // (50 + 70) / 2
      expect(res.restingHr).toBe(40); // latest record
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

suite("fetchWeekWellnessStats (computed fitness/form/totalLoad)", () => {
  it("derives fitness/form from the fold and totalLoad from computed day loads", async () => {
    const user = await createTestUser({ role: "premium", intervals: true });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 40 });
      await seedLoad(user.id, { day: "2026-05-03", trainingLoad: 60 });
      wellnessStub.records = [
        wellness("2026-05-02", { sleepScore: 80, fatigue: 2, atlLoad: 500 }),
        wellness("2026-05-03", { sleepScore: 90, fatigue: 4, atlLoad: 500 }),
      ];
      const res = await fetchWeekWellnessStats(db, user.id, "2026-05-01", "2026-05-05");
      expect(res).not.toBeNull();
      if (!res) return;
      expect(typeof res.fitness).toBe("number");
      expect(typeof res.form).toBe("number"); // form = ctl − atl (same-day)
      // totalLoad = computed day loads in range (40 + 60), NOT the wellness atlLoad (1000).
      expect(res.totalLoad).toBe(100);
      expect(res.avgSleepScore).toBe(85);
      expect(res.avgFatigue).toBe(3);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

suite("fetchWellnessSeries (merged computed + wellness)", () => {
  it("sources fitness metrics from the fold and other metrics from wellness", async () => {
    const user = await createTestUser({ role: "premium", intervals: true });
    try {
      await seedLoad(user.id, { day: "2026-05-02", trainingLoad: 70 });
      wellnessStub.records = [
        wellness("2026-05-02", { ctl: 999, atl: 999, hrv: 58, sleepScore: 85 }),
      ];
      const res = await fetchWellnessSeries(db, user.id, "2026-05-02", "2026-05-04");
      expect(res.status).toBe("ok");
      if (res.status !== "ok") return;

      const day = res.data.points.find((p) => p.date === "2026-05-02");
      expect(day).toBeDefined();
      if (!day) return;
      expect(day.fitness.ctl).not.toBe(999); // computed
      expect(day.fitness.ctl).toBeGreaterThan(0);
      expect(day.recovery.hrv).toBe(58); // from wellness
      expect(day.sleep.sleepScore).toBe(85);

      // ctl available from the fold; hrv from wellness.
      expect(res.data.metricsAvailable).toContain("ctl");
      expect(res.data.metricsAvailable).toContain("hrv");
      // Computed metric summary is not the wellness passthrough.
      expect(res.data.summary.ctl.latest).not.toBe(999);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
