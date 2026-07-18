import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { applyRevisionForUser } from "../src/repositories/training_plan_repository";
import { plannedSessions, trainingPlans } from "../src/schema";
import type { PlanRevisionChange } from "../src/schemas/agent_schemas";
import {
  closePool,
  createTestUser,
  deleteTestUser,
  getDb,
  getPool,
} from "./helpers/db";
import {
  insertPlannedSession,
  insertTrainingPlan,
  insertTrainingPlanWeek,
} from "./helpers/fixtures";

let userA: { id: string; clerkId: string };
let userB: { id: string; clerkId: string };

beforeAll(async () => {
  getPool();
  userA = await createTestUser({ role: "premium" });
  userB = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(userA.id);
  await deleteTestUser(userB.id);
  await closePool();
});

async function metaOf(planId: number) {
  const db = getDb();
  const [row] = await db
    .select({ meta: trainingPlans.meta })
    .from(trainingPlans)
    .where(eq(trainingPlans.id, planId));
  return row.meta as { revisions?: { at: string; rationale: string | null; changes: unknown[] }[] };
}

describe("applyRevisionForUser", () => {
  it("applies a mixed batch atomically and records the revision in meta", async () => {
    const plan = await insertTrainingPlan(userA.id, { name: "Mixed batch plan" });
    const week1 = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const week2 = await insertTrainingPlanWeek(plan.id, { weekIndex: 1, startDate: "2026-01-08" });
    const toMove = await insertPlannedSession(plan.id, week1.id, {
      date: "2026-01-02",
      title: "Easy Run",
    });
    const toUpdate = await insertPlannedSession(plan.id, week1.id, {
      date: "2026-01-03",
      title: "Old title",
      sessionType: "TEMPO",
    });
    const toDrop = await insertPlannedSession(plan.id, week1.id, {
      date: "2026-01-04",
      title: "Drop me",
    });

    const changes: PlanRevisionChange[] = [
      { kind: "move_session", sessionId: toMove.id, toDate: "2026-01-05" },
      {
        kind: "update_session",
        sessionId: toUpdate.id,
        patch: { title: "New title", sessionType: "TEMPO" },
      },
      { kind: "drop_session", sessionId: toDrop.id },
      {
        kind: "add_session",
        weekId: week2.id,
        session: { date: "2026-01-09", sessionType: "LONG", title: "New long run" },
      },
      {
        kind: "update_week",
        weekId: week2.id,
        patch: { targetDistanceMeters: 20000, notes: "back off a touch" },
      },
    ];

    const detail = await applyRevisionForUser(
      getDb(),
      userA.id,
      plan.id,
      changes,
      "adjusting for a tired week",
    );

    const moved = detail.sessions.find((s) => s.id === toMove.id);
    expect(moved?.date).toBe("2026-01-05");

    const updated = detail.sessions.find((s) => s.id === toUpdate.id);
    expect(updated?.title).toBe("New title");

    expect(detail.sessions.find((s) => s.id === toDrop.id)).toBeUndefined();

    const added = detail.sessions.find((s) => s.weekId === week2.id && s.title === "New long run");
    expect(added).toBeDefined();

    const week2Updated = detail.weeks.find((w) => w.id === week2.id);
    expect(week2Updated?.targetDistanceMeters).toBe(20000);
    expect(week2Updated?.notes).toBe("back off a touch");

    const meta = await metaOf(plan.id);
    expect(meta.revisions).toHaveLength(1);
    expect(meta.revisions?.[0].rationale).toBe("adjusting for a tired week");
    expect(typeof meta.revisions?.[0].at).toBe("string");
    expect(meta.revisions?.[0].changes).toHaveLength(5);
  });

  it("rejects a sessionId belonging to another plan and applies nothing (rollback)", async () => {
    const planX = await insertTrainingPlan(userA.id, { name: "Plan X" });
    const weekX = await insertTrainingPlanWeek(planX.id, { weekIndex: 0 });
    const sessionX = await insertPlannedSession(planX.id, weekX.id, { title: "Untouched" });

    const planY = await insertTrainingPlan(userA.id, { name: "Plan Y" });
    const weekY = await insertTrainingPlanWeek(planY.id, { weekIndex: 0 });
    const sessionY = await insertPlannedSession(planY.id, weekY.id, { title: "Also untouched" });

    const changes: PlanRevisionChange[] = [
      { kind: "move_session", sessionId: sessionX.id, toDate: "2026-02-01" },
      { kind: "move_session", sessionId: sessionY.id, toDate: "2026-02-01" }, // belongs to planY, not planX
    ];

    await expect(applyRevisionForUser(getDb(), userA.id, planX.id, changes)).rejects.toThrow();

    const db = getDb();
    const [freshX] = await db
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.id, sessionX.id));
    expect(freshX.date).toBe(sessionX.date);

    const metaX = await metaOf(planX.id);
    expect(metaX.revisions ?? []).toHaveLength(0);
  });

  it("404s applying a revision to another user's plan", async () => {
    const plan = await insertTrainingPlan(userB.id, { name: "User B plan" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const session = await insertPlannedSession(plan.id, week.id);

    await expect(
      applyRevisionForUser(getDb(), userA.id, plan.id, [
        { kind: "move_session", sessionId: session.id, toDate: "2026-03-01" },
      ]),
    ).rejects.toThrow();
  });

  it("appends successive revisions to meta.revisions, preserving prior entries", async () => {
    const plan = await insertTrainingPlan(userA.id, { name: "Repeat revisions plan" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const session = await insertPlannedSession(plan.id, week.id, { date: "2026-04-01" });

    await applyRevisionForUser(
      getDb(),
      userA.id,
      plan.id,
      [{ kind: "move_session", sessionId: session.id, toDate: "2026-04-02" }],
      "first nudge",
    );
    await applyRevisionForUser(
      getDb(),
      userA.id,
      plan.id,
      [{ kind: "move_session", sessionId: session.id, toDate: "2026-04-03" }],
      "second nudge",
    );

    const meta = await metaOf(plan.id);
    expect(meta.revisions).toHaveLength(2);
    expect(meta.revisions?.[0].rationale).toBe("first nudge");
    expect(meta.revisions?.[1].rationale).toBe("second nudge");
  });
});
