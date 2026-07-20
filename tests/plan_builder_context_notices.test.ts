import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import * as feedbackIntent from "../src/agent/planning/feedback_intent";
import { gatherContext } from "../src/agent/planning/nodes/gather_context";
import {
  buildPlanBuilderGraph,
  resetPlanBuilderThread,
} from "../src/agent/planning/plan_builder_graph";
import type {
  GenerateSessionsOutput,
  PlanMacro,
  PlanNotice,
} from "../src/agent/planning/plan_builder_schemas";
import type { PlanBuilderState } from "../src/agent/planning/plan_builder_state";
import * as macroAgent from "../src/agent/planning/plan_macro_agent";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import * as dashboardRepo from "../src/repositories/dashboard_repository";
import * as eventRepo from "../src/repositories/event_repository";
import * as intervalStructureRepo from "../src/repositories/interval_structure_repository";
import * as userRepo from "../src/repositories/user_repository";
import * as userSettingsRepo from "../src/repositories/user_settings_repository";
import * as fitnessService from "../src/services/fitness_metrics_service";
import * as paceAnchorService from "../src/services/pace_anchor_service";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";

// A gatherContext degradation (e.g. the health-events query failing) must reach
// the athlete as a notice, not just a log WARN — a plan silently built without
// injury records is the bug these tests pin.

const nodeState = (userId: string) =>
  ({
    userId,
    input: { startDate: "2026-01-05", endDate: "2026-01-25" },
  }) as PlanBuilderState;

const nodeConfig = () => ({ configurable: { thread_id: "test", db: {} as never } });

describe("gatherContext — degradation notices (node-level)", () => {
  const spies: { mockRestore: () => void }[] = [];
  let listSpy: { mockRestore: () => void } | null = null;

  beforeAll(() => {
    spies.push(
      spyOn(userRepo, "findById").mockResolvedValue(null as never),
      spyOn(userSettingsRepo, "findOrCreateUserSettings").mockResolvedValue(null as never),
      spyOn(dashboardRepo, "runWeeksWithTypeSince").mockResolvedValue([] as never),
      spyOn(dashboardRepo, "runsBetween").mockResolvedValue([] as never),
      spyOn(fitnessService, "computeFitnessDay").mockResolvedValue(null as never),
      spyOn(paceAnchorService, "fetchPaceAnchor").mockResolvedValue({
        status: "not_linked",
        data: null,
      } as never),
      spyOn(intervalStructureRepo, "listDistinctForUser").mockResolvedValue([] as never),
    );
  });

  afterEach(() => {
    listSpy?.mockRestore();
    listSpy = null;
  });

  afterAll(() => {
    for (const s of spies) s.mockRestore();
  });

  it("a thrown health-events query produces the context_health_events_unavailable notice", async () => {
    listSpy = spyOn(eventRepo, "listForUser").mockRejectedValue(new Error("schema drift"));

    const update = await gatherContext(nodeState("user-1"), nodeConfig());

    const notices = update.contextNotices as PlanNotice[];
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("clamped");
    expect(notices[0].code).toBe("context_health_events_unavailable");
    expect(notices[0].message).toContain("WITHOUT injury accommodations");
    expect(update.athleteContext?.activeHealthEvents).toEqual([]);
  });

  it("the no-data-on-record path emits no notices", async () => {
    listSpy = spyOn(eventRepo, "listForUser").mockResolvedValue([] as never);

    const update = await gatherContext(nodeState("user-1"), nodeConfig());

    expect(update.contextNotices).toEqual([]);
    expect(update.athleteContext?.activeHealthEvents).toEqual([]);
  });
});

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
      { date: "2026-01-06", sessionType: "LONG_INTERVALS", title: "5x1000m", structure: null },
      { date: "2026-01-08", sessionType: "EASY", title: "Easy run", structure: null },
    ],
  })),
});

describe("plan-builder graph — context notices reach the review interrupts", () => {
  let userId: string;
  const threadId = `plan-builder:${randomUUID()}`;
  const spies: { mockRestore: () => void }[] = [];

  const input = {
    name: "My 5k plan",
    startDate: "2026-01-05",
    endDate: "2026-01-25",
    goalText: "sub-20 5k",
  };

  const config = () => ({ configurable: { thread_id: threadId, db: getDb() } });

  const interruptValue = (state: { tasks: { interrupts: { value: unknown }[] }[] }) =>
    state.tasks.flatMap((t) => t.interrupts)[0]?.value as { notices: PlanNotice[] };

  beforeAll(async () => {
    const user = await createTestUser({ intervals: false });
    userId = user.id;

    spies.push(
      spyOn(macroAgent, "invokeProposeMacroAgent").mockResolvedValue(rawMacro()),
      spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockResolvedValue(sessionsOutput()),
      spyOn(feedbackIntent, "extractPlanInputPatch").mockResolvedValue({}),
      spyOn(eventRepo, "listForUser").mockRejectedValue(new Error("schema drift")),
    );

    await resetPlanBuilderThread(threadId);
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await resetPlanBuilderThread(threadId).catch(() => {});
    await deleteTestUser(userId);
  });

  it("the macro-review interrupt payload carries the health-events notice", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke({ userId, input }, config());

    const state = await graph.getState(config());
    expect(state.next).toContain("macroReview");

    const notices = interruptValue(state).notices;
    expect(notices.map((n) => n.code)).toContain("context_health_events_unavailable");

    const persisted = state.values.contextNotices as PlanNotice[];
    expect(persisted.map((n) => n.code)).toEqual(["context_health_events_unavailable"]);
  });

  it("an adjust round does not clobber the context notice", async () => {
    const graph = await buildPlanBuilderGraph();
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "add more mileage" } }),
      config(),
    );

    const state = await graph.getState(config());
    expect(state.next).toContain("macroReview");
    expect(interruptValue(state).notices.map((n) => n.code)).toContain(
      "context_health_events_unavailable",
    );
  });
});
