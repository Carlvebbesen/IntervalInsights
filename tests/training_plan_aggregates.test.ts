import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  estimatePlannedSessionDistanceMeters,
  parseDistanceHintMeters,
} from "../src/agent/planning/guards";
import { plannedSessions } from "../src/schema";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import {
  insertActivity,
  insertPlannedSession,
  insertRaceEvent,
  insertTrainingPlan,
  insertTrainingPlanWeek,
} from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({ userId: user.id, role: "premium" as const });

// 3x1000m with 60s recovery — estimator counts work + step recovery only.
const intervalStructure: WorkoutStructureSet[] = [
  {
    set_reps: 3,
    set_recovery: 90,
    steps: [
      {
        reps: 1,
        work_type: "DISTANCE",
        work_value: 1000,
        recovery_type: "TIME",
        recovery_value: 60,
        target_pace: null,
      },
    ],
  },
];

async function linkSessionToActivity(sessionId: number, activityId: number) {
  await getDb()
    .update(plannedSessions)
    .set({ completedActivityId: activityId, status: "completed" })
    .where(eq(plannedSessions.id, sessionId));
}

describe("distance-hint parser", () => {
  it("parses the `~X.X km` hint the plan-builder writes", () => {
    expect(parseDistanceHintMeters("Easy shakeout — ~8.0 km")).toBe(8000);
    expect(parseDistanceHintMeters("~12.5 km")).toBe(12500);
    expect(parseDistanceHintMeters("~ 5 km")).toBe(5000);
  });

  it("returns 0 when there is no parsable hint", () => {
    expect(parseDistanceHintMeters(null)).toBe(0);
    expect(parseDistanceHintMeters("")).toBe(0);
    expect(parseDistanceHintMeters("just an easy run")).toBe(0);
  });

  it("prefers the structure estimate, falls back to the hint", () => {
    expect(estimatePlannedSessionDistanceMeters(intervalStructure, "~99 km")).toBe(3500);
    expect(estimatePlannedSessionDistanceMeters(null, "~6.0 km")).toBe(6000);
    expect(estimatePlannedSessionDistanceMeters([], "~6.0 km")).toBe(6000);
  });
});

describe("GET /api/v1/training-plans/:id plan-vs-actual aggregates", () => {
  it("computes week aggregates over mixed linked/unlinked/skipped sessions and a grouped query across two weeks", async () => {
    const plan = await insertTrainingPlan(user.id, { status: "draft" });
    const week0 = await insertTrainingPlanWeek(plan.id, { weekIndex: 0, startDate: "2026-01-05" });
    const week1 = await insertTrainingPlanWeek(plan.id, { weekIndex: 1, startDate: "2026-01-12" });

    const sessionA = await insertPlannedSession(plan.id, week0.id, {
      date: "2026-01-06",
      sessionType: "LONG_INTERVALS",
      title: "Intervals",
      structure: intervalStructure,
    });
    await insertPlannedSession(plan.id, week0.id, {
      date: "2026-01-07",
      sessionType: "EASY",
      title: "Easy",
      description: "Easy — ~8.0 km",
      status: "skipped",
    });
    await insertPlannedSession(plan.id, week0.id, {
      date: "2026-01-08",
      sessionType: "EASY",
      title: "Easy 2",
      description: "~5.0 km",
    });
    const sessionD = await insertPlannedSession(plan.id, week1.id, {
      date: "2026-01-13",
      sessionType: "LONG",
      title: "Long",
      description: "~20.0 km",
    });

    const actA = await insertActivity(user.id, { distance: 6000, trainingLoad: 80 });
    const actD = await insertActivity(user.id, { distance: 21000, trainingLoad: 150 });
    await linkSessionToActivity(sessionA.id, actA.id);
    await linkSessionToActivity(sessionD.id, actD.id);

    const res = await withIdentity(identity(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${plan.id}`)),
    );
    expect(res.status).toBe(200);
    const detail = await res.json();

    const w0 = detail.weeks.find((w: { weekIndex: number }) => w.weekIndex === 0);
    const w1 = detail.weeks.find((w: { weekIndex: number }) => w.weekIndex === 1);

    expect(w0.sessionCount).toBe(3);
    expect(w0.completedCount).toBe(1);
    expect(w0.skippedCount).toBe(1);
    expect(w0.plannedDistanceMeters).toBe(3500 + 8000 + 5000);
    expect(w0.actualDistanceMeters).toBe(6000);
    expect(w0.actualTrainingLoad).toBe(80);

    expect(w1.sessionCount).toBe(1);
    expect(w1.completedCount).toBe(1);
    expect(w1.skippedCount).toBe(0);
    expect(w1.plannedDistanceMeters).toBe(20000);
    expect(w1.actualDistanceMeters).toBe(21000);
    expect(w1.actualTrainingLoad).toBe(150);

    // 2 completed of 3 non-skipped (4 total, 1 skipped) → 67%.
    expect(detail.completionPct).toBe(67);
    expect(detail.raceCountdownDays).toBe(null);
  });

  it("returns a positive raceCountdownDays for a future race and null once past", async () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 10);
    const futureISO = future.toISOString().slice(0, 10);
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 3);
    const pastISO = past.toISOString().slice(0, 10);

    const futureRace = await insertRaceEvent(user.id, { date: futureISO });
    const futurePlan = await insertTrainingPlan(user.id, { raceEventId: futureRace.id });
    const futureRes = await withIdentity(identity(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${futurePlan.id}`)),
    );
    expect((await futureRes.json()).raceCountdownDays).toBe(10);

    const pastRace = await insertRaceEvent(user.id, { date: pastISO, status: "completed" });
    const pastPlan = await insertTrainingPlan(user.id, { raceEventId: pastRace.id });
    const pastRes = await withIdentity(identity(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${pastPlan.id}`)),
    );
    expect((await pastRes.json()).raceCountdownDays).toBe(null);
  });

  it("reports completionPct 0 for a plan whose only sessions are skipped", async () => {
    const plan = await insertTrainingPlan(user.id, { status: "draft" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    await insertPlannedSession(plan.id, week.id, { status: "skipped" });

    const res = await withIdentity(identity(), () =>
      app.fetch(new Request(`http://test/api/v1/training-plans/${plan.id}`)),
    );
    expect((await res.json()).completionPct).toBe(0);
  });
});
