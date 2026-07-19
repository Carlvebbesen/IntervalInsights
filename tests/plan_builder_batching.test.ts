import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import {
  buildPlanBuilderGraph,
  resetPlanBuilderThread,
} from "../src/agent/planning/plan_builder_graph";
import type {
  GenerateSessionsOutput,
  PlanMacro,
  PlanMacroWeek,
} from "../src/agent/planning/plan_builder_schemas";
import * as macroAgent from "../src/agent/planning/plan_macro_agent";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import { getWithDetailForUser } from "../src/repositories/training_plan_repository";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Drives the REAL compiled graph for a 6-week plan and proves that
// generateSessions chunks the macro into ≤4-week batches: one structured LLM
// call per batch (2 calls for 6 weeks), a sessions_progress custom event
// emitted after each, and every batch's sessions persisted.

const SIX_WEEK_MACRO = (): PlanMacro => ({
  name: "Stub 12-week-ish plan",
  rationale: "base into build",
  weeks: Array.from({ length: 6 }, (_v, i) => ({
    weekIndex: i + 1,
    startDate: "ignored",
    phase: "base" as const,
    targetDistanceMeters: 30000,
    keySessions: ["Long run"],
  })),
});

// Returns exactly the batch weeks it was asked for, so weeks 5-6 (the second
// batch) prove they were generated and persisted.
function sessionsForBatch(weeks: PlanMacroWeek[]): GenerateSessionsOutput {
  return {
    weeks: weeks.map((w) => ({
      weekIndex: w.weekIndex,
      sessions: [{ date: w.startDate, sessionType: "EASY", title: `Easy w${w.weekIndex}` }],
    })),
  };
}

describe("plan-builder generateSessions — batched over ≤4-week chunks", () => {
  let userId: string;
  const threadId = `plan-builder:${randomUUID()}`;
  const spies: { mockRestore: () => void }[] = [];
  let sessionsSpy: ReturnType<typeof spyOn>;

  const input = {
    name: "6-week plan",
    startDate: "2026-01-05",
    endDate: "2026-02-15",
    goalText: "build base",
  };

  const config = () => ({ configurable: { thread_id: threadId, db: getDb() } });

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false });
    userId = user.id;

    spies.push(spyOn(macroAgent, "invokeProposeMacroAgent").mockResolvedValue(SIX_WEEK_MACRO()));
    sessionsSpy = spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockImplementation(
      (async (_ctx: unknown, weeks: PlanMacroWeek[]) =>
        sessionsForBatch(weeks)) as typeof sessionsAgent.invokeGenerateSessionsAgent,
    );
    spies.push(sessionsSpy);

    await resetPlanBuilderThread(threadId);
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await resetPlanBuilderThread(threadId).catch(() => {});
    await deleteTestUser(userId);
  });

  it("calls the session agent once per ≤4-week batch and emits progress between them", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke({ userId, input }, config());

    const callsBefore = sessionsSpy.mock.calls.length;

    const progress: { completedWeeks: number; totalWeeks: number }[] = [];
    const events = await graph.stream(new Command({ resume: { action: "accept" } }), {
      ...config(),
      streamMode: ["custom", "updates"],
    });
    for await (const ev of events) {
      const [mode, data] = ev as [string, Record<string, unknown>];
      if (mode === "custom" && data.phase === "sessions_progress") {
        progress.push({
          completedWeeks: data.completedWeeks as number,
          totalWeeks: data.totalWeeks as number,
        });
      }
    }

    // 6 weeks → batches of [4, 2] → two structured calls.
    const batchCalls = sessionsSpy.mock.calls.slice(callsBefore);
    expect(batchCalls).toHaveLength(2);
    expect((batchCalls[0][1] as PlanMacroWeek[]).length).toBe(4);
    expect((batchCalls[1][1] as PlanMacroWeek[]).length).toBe(2);

    expect(progress).toEqual([
      { completedWeeks: 4, totalWeeks: 6 },
      { completedWeeks: 6, totalWeeks: 6 },
    ]);

    const state = await graph.getState(config());
    const byWeek = state.values.sessionsByWeek as { weekIndex: number; sessions: unknown[] }[];
    expect(byWeek).toHaveLength(6);
    // Second batch (weeks 5-6) really produced sessions.
    expect(byWeek.find((w) => w.weekIndex === 5)?.sessions.length).toBeGreaterThan(0);
    expect(byWeek.find((w) => w.weekIndex === 6)?.sessions.length).toBeGreaterThan(0);
  });

  it("sessions adjust re-runs every batch (feedback applies to the whole plan)", async () => {
    const graph = await buildPlanBuilderGraph();
    const callsBefore = sessionsSpy.mock.calls.length;

    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "more long runs" } }),
      config(),
    );

    const batchCalls = sessionsSpy.mock.calls.slice(callsBefore);
    expect(batchCalls).toHaveLength(2); // full regen, both batches again
    expect((batchCalls[0][1] as PlanMacroWeek[]).length).toBe(4);
    expect((batchCalls[1][1] as PlanMacroWeek[]).length).toBe(2);
  });

  it("persists all six weeks with sessions from both batches", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke(new Command({ resume: { action: "accept" } }), config());

    const state = await graph.getState(config());
    expect(state.next).toHaveLength(0);
    const planId = state.values.persistedPlanId as number;

    const detail = await getWithDetailForUser(getDb(), userId, planId);
    expect(detail?.weeks).toHaveLength(6);
    const weeksWithSessions = new Set(detail?.sessions.map((s) => s.weekId));
    // At least one session in each of the 6 weeks (every batch persisted).
    expect(detail?.sessions.length).toBeGreaterThanOrEqual(6);
    expect(weeksWithSessions.size).toBe(6);
  });
});
