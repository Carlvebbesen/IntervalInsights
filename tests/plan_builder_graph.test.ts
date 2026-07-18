import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Command } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as macroAgent from "../src/agent/planning/plan_macro_agent";
import { buildPlanBuilderGraph, resetPlanBuilderThread } from "../src/agent/planning/plan_builder_graph";
import type { GenerateSessionsOutput, PlanMacro } from "../src/agent/planning/plan_builder_schemas";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import { getWithDetailForUser } from "../src/repositories/training_plan_repository";
import { trainingPlans } from "../src/schema";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Drives the REAL compiled plan-builder graph (real PostgresSaver checkpointer,
// real nodes + deterministic guards). Only the two LLM seams are stubbed:
// invokeProposeMacroAgent + invokeGenerateSessionsAgent.

const rawMacro = (): PlanMacro => ({
  name: "Stub 5k Plan",
  rationale: "progressive base into a sharpening block",
  weeks: [
    { weekIndex: 1, startDate: "ignored", phase: "base", targetDistanceMeters: 30000, keySessions: ["5x1000m"] },
    { weekIndex: 2, startDate: "ignored", phase: "build", targetDistanceMeters: 34000, keySessions: ["Tempo 20min"] },
    { weekIndex: 3, startDate: "ignored", phase: "build", targetDistanceMeters: 36000, keySessions: ["6x800m"] },
  ],
});

const sessionsOutput = (): GenerateSessionsOutput => ({
  weeks: [1, 2, 3].map((weekIndex) => ({
    weekIndex,
    sessions: [
      {
        date: "2026-01-06",
        sessionType: "LONG_INTERVALS",
        title: "5x1000m",
        // Deliberately carries a pace to prove the guard force-nulls it.
        structure: [
          {
            set_reps: 1,
            steps: [
              { reps: 5, work_type: "DISTANCE", work_value: 1000, target_pace: 210, target_paces: [210] },
            ],
          },
        ],
      },
      { date: "2026-01-08", sessionType: "EASY", title: "Easy run", structure: null },
    ],
  })),
});

describe("plan-builder graph — guided creation flow (end-to-end)", () => {
  let userId: string;
  const threadId = `plan-builder:${randomUUID()}`;
  const spies: { mockRestore: () => void }[] = [];
  let macroSpy: ReturnType<typeof spyOn>;

  const input = {
    name: "My 5k plan",
    startDate: "2026-01-05",
    endDate: "2026-01-25",
    goalText: "sub-20 5k",
  };

  const config = () => ({
    configurable: { thread_id: threadId, db: getDb() },
  });

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false });
    userId = user.id;

    macroSpy = spyOn(macroAgent, "invokeProposeMacroAgent").mockResolvedValue(rawMacro());
    spies.push(macroSpy);
    spies.push(
      spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockResolvedValue(sessionsOutput()),
    );

    await resetPlanBuilderThread(threadId);
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await resetPlanBuilderThread(threadId).catch(() => {});
    await deleteTestUser(userId);
  });

  it("runs to the macro-review interrupt with a repaired 3-week macro", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke({ userId, input }, config());

    const state = await graph.getState(config());
    const interrupts = state.tasks.reduce((n, t) => n + t.interrupts.length, 0);
    expect(interrupts).toBe(1);
    expect(state.next).toContain("macroReview");

    const macro = state.values.macro as PlanMacro;
    expect(macro.weeks).toHaveLength(3);
    expect(macro.weeks.map((w) => w.startDate)).toEqual([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
    ]);
  });

  it("adjust resume re-runs proposeMacro and accumulates feedback", async () => {
    const graph = await buildPlanBuilderGraph();
    const callsBefore = macroSpy.mock.calls.length;

    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "add more mileage" } }),
      config(),
    );

    expect(macroSpy.mock.calls.length).toBe(callsBefore + 1);

    const state = await graph.getState(config());
    expect(state.values.macroFeedback).toEqual(["add more mileage"]);
    expect(state.next).toContain("macroReview"); // parked again after re-propose
  });

  it("accept → generateSessions → sessions-review interrupt", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke(new Command({ resume: { action: "accept" } }), config());

    const state = await graph.getState(config());
    const interrupts = state.tasks.reduce((n, t) => n + t.interrupts.length, 0);
    expect(interrupts).toBe(1);
    expect(state.next).toContain("sessionsReview");
    const byWeek = state.values.sessionsByWeek as { weekIndex: number; sessions: unknown[] }[];
    expect(byWeek).toHaveLength(3);
  });

  it("accept persists an active plan with weeks, sessions, null paces and meta", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke(new Command({ resume: { action: "accept" } }), config());

    const state = await graph.getState(config());
    expect(state.next).toHaveLength(0); // reached END
    const planId = state.values.persistedPlanId as number;
    expect(planId).toBeGreaterThan(0);

    const db = getDb();
    const detail = await getWithDetailForUser(db, userId, planId);
    expect(detail?.plan.status).toBe("active");
    expect(detail?.weeks).toHaveLength(3);
    expect(detail?.sessions.length).toBeGreaterThan(0);

    const structured = detail?.sessions.find((s) => s.structure != null);
    expect(structured?.structure?.[0].steps[0].target_pace).toBeNull();

    const [row] = await db
      .select({ meta: trainingPlans.meta })
      .from(trainingPlans)
      .where(eq(trainingPlans.id, planId));
    expect((row.meta as { createdVia?: string }).createdVia).toBe("plan_builder");
    expect((row.meta as { feedbackRounds?: { macro: number } }).feedbackRounds?.macro).toBe(1);
  });
});
