import { afterAll, describe, expect, it } from "bun:test";
import {
  dailyLoadSums,
  earliestIcuFitnessSnapshot,
} from "../src/repositories/fitness_metrics_repository";
import { computeFitnessDay, computeFitnessSeries } from "../src/services/fitness_metrics_service";
import { activities } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";

afterAll(async () => {
  await closePool();
});

async function seedActivity(
  userId: string,
  opts: {
    day: string;
    sport?: string;
    trainingLoad?: number | null;
    icuTrainingLoad?: number | null;
    icuCtl?: number | null;
    icuAtl?: number | null;
  },
): Promise<void> {
  const db = getDb();
  await db.insert(activities).values({
    userId,
    stravaActivityId: Math.floor(Math.random() * 1e12),
    title: "t",
    sportType: opts.sport ?? "Run",
    distance: 5000,
    movingTime: 1500,
    startDateLocal: new Date(`${opts.day}T12:00:00`),
    indoor: false,
    trainingLoad: opts.trainingLoad ?? null,
    icuTrainingLoad: opts.icuTrainingLoad ?? null,
    icuCtl: opts.icuCtl ?? null,
    icuAtl: opts.icuAtl ?? null,
  });
}

describe("dailyLoadSums", () => {
  it("sums multiple activities on the same day", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-02-01", trainingLoad: 30 });
      await seedActivity(user.id, { day: "2026-02-01", trainingLoad: 20 });
      const rows = await dailyLoadSums(getDb(), user.id);
      expect(rows).toEqual([{ date: "2026-02-01", load: 50 }]);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("prefers trainingLoad over icuTrainingLoad (COALESCE) and skips both-null rows", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-02-01", trainingLoad: 40, icuTrainingLoad: 200 });
      await seedActivity(user.id, { day: "2026-02-02", trainingLoad: null, icuTrainingLoad: 70 });
      await seedActivity(user.id, { day: "2026-02-03", trainingLoad: null, icuTrainingLoad: null });
      const rows = await dailyLoadSums(getDb(), user.id);
      expect(rows).toEqual([
        { date: "2026-02-01", load: 40 },
        { date: "2026-02-02", load: 70 },
      ]);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("filters by sport: 'running' matches run types, an exact type matches itself", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-02-01", sport: "Run", trainingLoad: 30 });
      await seedActivity(user.id, { day: "2026-02-01", sport: "TrailRun", trainingLoad: 10 });
      await seedActivity(user.id, { day: "2026-02-01", sport: "Ride", trainingLoad: 50 });

      const running = await dailyLoadSums(getDb(), user.id, { sport: "running" });
      expect(running).toEqual([{ date: "2026-02-01", load: 40 }]);

      const ride = await dailyLoadSums(getDb(), user.id, { sport: "Ride" });
      expect(ride).toEqual([{ date: "2026-02-01", load: 50 }]);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns days in ascending order and honours oldest/newest bounds", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-03-05", trainingLoad: 3 });
      await seedActivity(user.id, { day: "2026-03-01", trainingLoad: 1 });
      await seedActivity(user.id, { day: "2026-03-03", trainingLoad: 2 });

      const all = await dailyLoadSums(getDb(), user.id);
      expect(all.map((r) => r.date)).toEqual(["2026-03-01", "2026-03-03", "2026-03-05"]);

      const bounded = await dailyLoadSums(getDb(), user.id, {
        oldest: "2026-03-02",
        newest: "2026-03-04",
      });
      expect(bounded).toEqual([{ date: "2026-03-03", load: 2 }]);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("earliestIcuFitnessSnapshot", () => {
  it("returns the earliest activity carrying both icuCtl and icuAtl", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-04-10", icuCtl: 55, icuAtl: 44 });
      await seedActivity(user.id, { day: "2026-04-01", icuCtl: 50, icuAtl: 40 });
      await seedActivity(user.id, { day: "2026-03-20", icuCtl: null, icuAtl: null });

      const snap = await earliestIcuFitnessSnapshot(getDb(), user.id);
      expect(snap).toEqual({ date: "2026-04-01", icuCtl: 50, icuAtl: 40 });
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns null when no activity has a snapshot", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, { day: "2026-04-01", trainingLoad: 30 });
      expect(await earliestIcuFitnessSnapshot(getDb(), user.id)).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("computeFitnessSeries", () => {
  it("seeds the combined series from the earliest icu snapshot", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, {
        day: "2026-03-01",
        trainingLoad: 100,
        icuCtl: 50,
        icuAtl: 40,
      });
      const series = await computeFitnessSeries(getDb(), user.id, {
        oldest: "2026-03-01",
        newest: "2026-03-01",
      });
      expect(series).toHaveLength(1);
      // Seeded recursion from ctl=50/atl=40 with a 100 load, not a cold start.
      expect(series[0].ctl).toBeCloseTo(51.176, 2);
      expect(series[0].atl).toBeCloseTo(47.987, 2);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("never seeds a per-sport series (cold start from zero)", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      await seedActivity(user.id, {
        day: "2026-03-01",
        sport: "Run",
        trainingLoad: 100,
        icuCtl: 50,
        icuAtl: 40,
      });
      const series = await computeFitnessSeries(getDb(), user.id, {
        oldest: "2026-03-01",
        newest: "2026-03-01",
        sport: "running",
      });
      expect(series).toHaveLength(1);
      expect(series[0].ctl).toBeCloseTo(2.352831, 4);
      expect(series[0].atl).toBeCloseTo(13.31221, 4);
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns an empty series for a user with no load history", async () => {
    const user = await createTestUser({ role: "premium" });
    try {
      const series = await computeFitnessSeries(getDb(), user.id, {
        oldest: "2026-01-01",
        newest: "2026-01-31",
      });
      expect(series).toEqual([]);
      expect(await computeFitnessDay(getDb(), user.id, "2026-01-15")).toBeNull();
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
