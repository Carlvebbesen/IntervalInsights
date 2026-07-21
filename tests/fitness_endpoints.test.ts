// Self-computed fitness swap (waves 1/3/4). fitness_service is NOT mocked in
// tests/setup.ts, so these endpoint tests exercise the REAL computed fold; only
// intervals_api_service.getWellness is stubbed (default [] → data points null).
// A Strava-only user (no intervals link) must still get a computed series, and
// an intervals-linked user must get COMPUTED ctl/atl — never the wellness
// passthrough values — plus the wellness data points merged in.

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { fitnessTools } from "../src/agent/training/tools/fitness";
import { isToolAvailable } from "../src/agent/training/tool_types";
import { activities } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());
const db = getDb();

async function seedLoad(
  userId: string,
  opts: { day: string; sport?: string; trainingLoad?: number; icuCtl?: number; icuAtl?: number },
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
    icuCtl: opts.icuCtl ?? null,
    icuAtl: opts.icuAtl ?? null,
  });
}

// Restores the exact default from tests/setup.ts so nothing leaks to later files.
const RESET_INTERVALS_API = () =>
  mock.module("../src/services/intervals_api_service.ts", () => ({
    DEFAULT_INTERVALS_STREAM_TYPES: [
      "time",
      "heartrate",
      "watts",
      "velocity_smooth",
      "distance",
      "altitude",
      "cadence",
    ],
    intervalsApiService: {
      getAthlete: async () => ({ id: "i12345" }),
      getWellness: async () => [],
      getActivity: async () => null,
      listActivities: async () => [],
    },
  }));

afterEach(() => {
  RESET_INTERVALS_API();
});

afterAll(async () => {
  RESET_INTERVALS_API();
  await closePool();
});

describe("GET /fitness (computed series)", () => {
  it("serves a computed series to a Strava-only user with null data points", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 80 });
      await seedLoad(user.id, { day: "2026-05-05", trainingLoad: 100 });
      await withIdentity(
        { userId: user.id, role: "premium" },
        async () => {
          const res = await app.fetch(
            new Request("http://test/api/v1/dashboard/fitness?oldest=2026-05-01&newest=2026-05-10"),
          );
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.status).toBe("ok");
          expect(body.data.points.length).toBeGreaterThan(0);
          const last = body.data.points.at(-1);
          expect(typeof last.ctl).toBe("number");
          expect(typeof last.atl).toBe("number");
          expect(last.tsb).toBeCloseTo(last.ctl - last.atl, 6);
          // No intervals link → data points are null.
          expect(last.hrv).toBeNull();
          expect(last.sleepScore).toBeNull();
        },
      );
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("returns computed ctl/atl (NOT the wellness passthrough) and merges data points when linked", async () => {
    const user = await createTestUser({ role: "premium", intervals: true });
    try {
      await seedLoad(user.id, { day: "2026-05-01", trainingLoad: 80 });
      await seedLoad(user.id, { day: "2026-05-10", trainingLoad: 100 });
      // Deliberately-different wellness ctl/atl — if the swap regressed and the
      // endpoint passed these through, the assertions below would catch it.
      mock.module("../src/services/intervals_api_service.ts", () => ({
        DEFAULT_INTERVALS_STREAM_TYPES: [],
        intervalsApiService: {
          getAthlete: async () => ({ id: "i12345" }),
          getWellness: async () => [
            { id: "2026-05-10", ctl: 999, atl: 999, hrv: 55, sleepScore: 88 },
          ],
          getActivity: async () => null,
          listActivities: async () => [],
        },
      }));
      await withIdentity(
        { userId: user.id, role: "premium" },
        async () => {
          const res = await app.fetch(
            new Request("http://test/api/v1/dashboard/fitness?oldest=2026-05-01&newest=2026-05-10"),
          );
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.status).toBe("ok");
          const day = body.data.points.find((p: { date: string }) => p.date === "2026-05-10");
          expect(day).toBeDefined();
          expect(day.ctl).not.toBe(999);
          expect(day.atl).not.toBe(999);
          expect(day.ctl).toBeLessThan(50); // cold-start fold, nowhere near 999
          // Data points still merged from the wellness record.
          expect(day.hrv).toBe(55);
          expect(day.sleepScore).toBe(88);
        },
      );
    } finally {
      await deleteTestUser(user.id);
    }
  });

  it("serves a per-sport series (sport=running excludes Ride load) and rejects unknown sports", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      await seedLoad(user.id, { day: "2026-05-02", sport: "Run", trainingLoad: 50 });
      await seedLoad(user.id, { day: "2026-05-02", sport: "Ride", trainingLoad: 90 });
      await withIdentity(
        { userId: user.id, role: "premium" },
        async () => {
          const combined = await (
            await app.fetch(
              new Request(
                "http://test/api/v1/dashboard/fitness?oldest=2026-05-02&newest=2026-05-02",
              ),
            )
          ).json();
          const running = await (
            await app.fetch(
              new Request(
                "http://test/api/v1/dashboard/fitness?oldest=2026-05-02&newest=2026-05-02&sport=running",
              ),
            )
          ).json();
          expect(combined.status).toBe("ok");
          expect(running.status).toBe("ok");
          const combinedCtl = combined.data.points[0].ctl;
          const runningCtl = running.data.points[0].ctl;
          // Running-only load (50) < combined load (140) ⇒ lower same-day ctl.
          expect(runningCtl).toBeLessThan(combinedCtl);

          const bad = await app.fetch(
            new Request(
              "http://test/api/v1/dashboard/fitness?oldest=2026-05-02&newest=2026-05-02&sport=Nonsense",
            ),
          );
          expect(bad.status).toBe(400);
        },
      );
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("GET /fitness/day/:date (computed)", () => {
  it("returns computed fitness with null data points for a Strava-only user", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      await seedLoad(user.id, { day: "2026-05-03", trainingLoad: 70 });
      await withIdentity(
        { userId: user.id, role: "premium" },
        async () => {
          const res = await app.fetch(
            new Request("http://test/api/v1/dashboard/fitness/day/2026-05-03"),
          );
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.date).toBe("2026-05-03");
          expect(body.fitness).not.toBeNull();
          expect(typeof body.fitness.ctl).toBe("number");
          expect(body.fitness.hrv).toBeNull();
          expect(body.activities.length).toBe(1);
        },
      );
    } finally {
      await deleteTestUser(user.id);
    }
  });
});

describe("fitness MCP tool gating + sport param", () => {
  it("fitness tools are activity-source gated (Strava-only allowed); wellness tools stay intervals-gated", () => {
    const byName = new Map(fitnessTools.map((t) => [t.name, t]));
    const stravaOnly = { intervalsConnected: false, stravaLinked: true } as never;
    for (const name of ["get_fitness_today", "get_fitness_day", "get_fitness_series"]) {
      expect(isToolAvailable(byName.get(name)!, stravaOnly)).toBe(true);
    }
    for (const name of ["get_wellness_summary", "get_week_wellness", "get_wellness_series"]) {
      expect(isToolAvailable(byName.get(name)!, stravaOnly)).toBe(false);
    }
  });

  it("get_fitness_series accepts an optional sport and returns a different per-sport series", async () => {
    const user = await createTestUser({ role: "premium", intervals: false });
    try {
      await seedLoad(user.id, { day: "2026-05-04", sport: "Run", trainingLoad: 40 });
      await seedLoad(user.id, { day: "2026-05-04", sport: "Ride", trainingLoad: 120 });
      const tool = fitnessTools.find((t) => t.name === "get_fitness_series")!;
      const ctx = {
        db,
        userId: user.id,
        userTime: "2026-05-04T12:00:00Z",
      } as never;

      expect(tool.params.safeParse({ sport: "running" }).success).toBe(true);
      expect(tool.params.safeParse({ sport: "Nonsense" }).success).toBe(false);

      const combined = (await tool.handler(ctx, {
        oldest: "2026-05-04",
        newest: "2026-05-04",
      })) as { status: string; data: { points: { ctl: number }[] } };
      const running = (await tool.handler(ctx, {
        oldest: "2026-05-04",
        newest: "2026-05-04",
        sport: "running",
      })) as { status: string; data: { points: { ctl: number }[] } };

      expect(combined.status).toBe("ok");
      expect(running.status).toBe("ok");
      expect(running.data.points[0].ctl).toBeLessThan(combined.data.points[0].ctl);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
