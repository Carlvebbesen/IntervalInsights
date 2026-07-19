import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isCommand } from "@langchain/langgraph";
import type { CoachCtx } from "../src/agent/training/tool_types";
import { createPlanRevisionTool } from "../src/agent/training/visual_tools";
import { logger } from "../src/logger";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
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

function ctxFor(userId: string): CoachCtx {
  return {
    db: getDb(),
    userId,
    stravaAccessToken: "",
    intervalsConnected: false,
    stravaLinked: false,
    userTime: new Date().toISOString(),
    logger,
  };
}

describe("create_plan_revision tool", () => {
  it("renders a plan_revision artifact when every reference belongs to the plan", async () => {
    const plan = await insertTrainingPlan(userA.id, { name: "Referential integrity plan" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const session = await insertPlannedSession(plan.id, week.id, { date: "2026-01-02" });

    const result = await createPlanRevisionTool.invoke(
      {
        planId: plan.id,
        title: "Move the easy run",
        rationale: "Athlete has a conflict that day",
        changes: [{ kind: "move_session", sessionId: session.id, toDate: "2026-01-03" }],
      },
      { context: ctxFor(userA.id) },
    );

    expect(isCommand(result)).toBe(true);
    const update = (result as { update: { pendingArtifacts: { type: string }[] } }).update;
    expect(update.pendingArtifacts[0].type).toBe("plan_revision");
  });

  it("rejects a sessionId that does not belong to the plan", async () => {
    const plan = await insertTrainingPlan(userA.id, { name: "Plan with own session" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    await insertPlannedSession(plan.id, week.id);

    const otherPlan = await insertTrainingPlan(userA.id, { name: "Other plan" });
    const otherWeek = await insertTrainingPlanWeek(otherPlan.id, { weekIndex: 0 });
    const otherSession = await insertPlannedSession(otherPlan.id, otherWeek.id);

    await expect(
      createPlanRevisionTool.invoke(
        {
          planId: plan.id,
          title: "Bad revision",
          rationale: "should fail",
          changes: [{ kind: "move_session", sessionId: otherSession.id, toDate: "2026-01-03" }],
        },
        { context: ctxFor(userA.id) },
      ),
    ).rejects.toThrow();
  });

  it("rejects a plan that does not belong to the calling user", async () => {
    const plan = await insertTrainingPlan(userB.id, { name: "User B's plan" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const session = await insertPlannedSession(plan.id, week.id);

    await expect(
      createPlanRevisionTool.invoke(
        {
          planId: plan.id,
          title: "Not yours",
          rationale: "should fail",
          changes: [{ kind: "move_session", sessionId: session.id, toDate: "2026-01-03" }],
        },
        { context: ctxFor(userA.id) },
      ),
    ).rejects.toThrow();
  });

  it("force-nulls any pace on structures carried in the changes (D8)", async () => {
    const plan = await insertTrainingPlan(userA.id, { name: "Pace stripping plan" });
    const week = await insertTrainingPlanWeek(plan.id, { weekIndex: 0 });
    const session = await insertPlannedSession(plan.id, week.id);

    const result = await createPlanRevisionTool.invoke(
      {
        planId: plan.id,
        title: "Add a session with a sneaky pace",
        rationale: "test",
        changes: [
          {
            kind: "add_session",
            weekId: week.id,
            session: {
              date: "2026-01-05",
              sessionType: "TEMPO",
              title: "Tempo",
              structure: [
                {
                  set_reps: 1,
                  steps: [
                    {
                      reps: 1,
                      work_type: "TIME",
                      work_value: 1200,
                      target_pace: 210,
                      target_paces: [210],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      { context: ctxFor(userA.id) },
    );

    const update = (
      result as {
        update: {
          pendingArtifacts: {
            changes: { kind: string; session?: { structure?: { steps: { target_pace: number | null }[] }[] } }[];
          }[];
        };
      }
    ).update;
    const change = update.pendingArtifacts[0].changes[0];
    expect(change.kind).toBe("add_session");
    expect(change.session?.structure?.[0].steps[0].target_pace).toBeNull();
    // ensure the untouched fixture row still exists / plan reference is valid
    expect(session.planId).toBe(plan.id);
  });
});
