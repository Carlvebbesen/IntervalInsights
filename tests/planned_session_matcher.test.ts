import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { plannedSessions } from "../src/schema";
import {
  matchActivityToPlannedSession,
  sweepOverduePlannedSessions,
} from "../src/services/planned_session_matcher";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import {
  insertActivity,
  insertPlannedSession,
  insertTrainingPlan,
  insertTrainingPlanWeek,
} from "./helpers/fixtures";

const db = getDb();
let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

async function activePlanWithWeek(overrides: Parameters<typeof insertTrainingPlan>[1] = {}) {
  const plan = await insertTrainingPlan(user.id, { status: "active", ...overrides });
  const week = await insertTrainingPlanWeek(plan.id, { startDate: "2026-04-06" });
  return { plan, week };
}

describe("matchActivityToPlannedSession", () => {
  it("links an exact same-day, same-type candidate", async () => {
    const { plan, week } = await activePlanWithWeek();
    const session = await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "EASY",
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "EASY",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(true);
    expect(result.sessionId).toBe(session.id);

    const [row] = await db
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, session.id));
    expect(row.status).toBe("completed");
    expect(row.completedActivityId).toBe(activity.id);
  });

  it("links a ±1-day, exact-type candidate", async () => {
    const { plan, week } = await activePlanWithWeek();
    const session = await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-11",
      sessionType: "EASY",
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "EASY",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(true);
    expect(result.sessionId).toBe(session.id);
  });

  it("links a same-day, bucket-only candidate with no structures on either side", async () => {
    const { plan, week } = await activePlanWithWeek();
    const session = await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "PROGRESSIVE_LONG", // same trainingBucketFor bucket ("LONG") as LONG
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "LONG",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(true);
    expect(result.sessionId).toBe(session.id);
  });

  it("does not link a ±1-day, bucket-only candidate (score below threshold)", async () => {
    const { plan, week } = await activePlanWithWeek();
    await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-11",
      sessionType: "PROGRESSIVE_LONG",
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "LONG",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(false);
  });

  it("never matches sessions from a draft (non-active) plan", async () => {
    const { plan, week } = await activePlanWithWeek({ status: "draft" });
    await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "EASY",
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "EASY",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(false);
  });

  it("is a no-op when the activity is already linked to a session", async () => {
    const { plan, week } = await activePlanWithWeek();
    const activity = await insertActivity(user.id, { sportType: "Run" });
    const alreadyLinked = await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "EASY",
    });
    await db
      .update(plannedSessions)
      .set({ completedActivityId: activity.id, status: "completed" })
      .where(eq(plannedSessions.id, alreadyLinked.id));

    // A second, otherwise-perfect candidate must not steal the already-linked activity.
    await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "EASY",
    });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "EASY",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(false);
  });

  it("picks the closest-dated candidate when scores tie", async () => {
    const { plan, week } = await activePlanWithWeek();
    // Same day, bucket-only match: 3 (date) + 2 (bucket) + 1 (no structure) = 6.
    const closer = await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "PROGRESSIVE_LONG",
    });
    // +1 day, exact type match: 1 (date) + 4 (type) + 1 (no structure) = 6.
    await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-11",
      sessionType: "LONG",
    });
    const activity = await insertActivity(user.id, { sportType: "Run" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "LONG",
      sportType: "Run",
      structureRepCount: null,
    });

    expect(result.linked).toBe(true);
    expect(result.sessionId).toBe(closer.id);
  });

  it("does not match a non-running sport type", async () => {
    const { plan, week } = await activePlanWithWeek();
    await insertPlannedSession(plan.id, week.id, {
      date: "2026-04-10",
      sessionType: "EASY",
    });
    const activity = await insertActivity(user.id, { sportType: "Ride" });

    const result = await matchActivityToPlannedSession(db, {
      userId: user.id,
      activityId: activity.id,
      activityDateLocal: "2026-04-10",
      trainingType: "EASY",
      sportType: "Ride",
      structureRepCount: null,
    });

    expect(result.linked).toBe(false);
  });
});

describe("sweepOverduePlannedSessions", () => {
  it("flips only overdue planned sessions of active plans, and returns the updated count", async () => {
    const { plan, week } = await activePlanWithWeek();
    const overdue = await insertPlannedSession(plan.id, week.id, { date: "2026-01-01" });
    // Exactly at the 1-day grace boundary (today - 1) — must NOT be swept.
    const recent = await insertPlannedSession(plan.id, week.id, { date: "2026-01-15" });

    const draftPlan = await insertTrainingPlan(user.id, { status: "draft" });
    const draftWeek = await insertTrainingPlanWeek(draftPlan.id, { startDate: "2025-12-01" });
    const overdueInDraft = await insertPlannedSession(draftPlan.id, draftWeek.id, {
      date: "2026-01-01",
    });

    const count = await sweepOverduePlannedSessions(db, user.id, "2026-01-16");
    expect(count).toBe(1);

    const [overdueRow] = await db
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, overdue.id));
    expect(overdueRow.status).toBe("skipped");

    const [recentRow] = await db
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, recent.id));
    expect(recentRow.status).toBe("planned");

    const [draftRow] = await db
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, overdueInDraft.id));
    expect(draftRow.status).toBe("planned");
  });
});
