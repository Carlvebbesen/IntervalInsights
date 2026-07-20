import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import { extractPlanInputPatch } from "../src/agent/planning/feedback_intent";
import {
  assembleWeekSessionsWithNotices,
  CROSS_TRAINING_TITLE,
  shapeMacro,
} from "../src/agent/planning/guards";
import {
  buildPlanBuilderGraph,
  resetPlanBuilderThread,
} from "../src/agent/planning/plan_builder_graph";
import type {
  GeneratedSession,
  GenerateSessionsOutput,
  PlanMacro,
  PlanMacroWeek,
  PlanNotice,
} from "../src/agent/planning/plan_builder_schemas";
import { MAX_REVIEW_ROUNDS } from "../src/agent/planning/plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "../src/agent/planning/plan_builder_state";
import * as macroAgent from "../src/agent/planning/plan_macro_agent";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import { createTestUser, deleteTestUser, getDb } from "./helpers/db";

// Proves the causal chain the wizard promises: feedback → prompt, feedback →
// patched planner input → different guarded output, and a refusal → a notice.
// The LLM seams are stubbed one layer BELOW the agent wrappers (invokeStructured)
// wherever the prompt or the extraction result is what's under test.

const ctx: AthleteContext = {
  athleteName: "Tester",
  maxHeartRate: 190,
  intervalsConnected: false,
  race: null,
  recentWeeks: [],
  fitness: null,
  raceAbility: null,
  baselineVolume: {
    trailing4WeekAvgWeeklyMeters: 40_000,
    longestRunLast30dMeters: 15_000,
    provenWeeklyMeters: null,
    provenLongestRunMeters: null,
  },
  activeHealthEvents: [],
  workoutVocabulary: { types: [], hasStructuredIntervalHistory: false, structures: [] },
};

const baseInput: PlanBuilderInput = {
  startDate: "2026-01-05",
  endDate: "2026-01-25",
  daysPerWeek: 3,
};

describe("free-text feedback reaches the planner prompt", () => {
  it("renders every accumulated round into the macro prompt", async () => {
    const prompts: string[] = [];
    const spy = spyOn(model, "invokeStructured").mockImplementation((async (
      _schema,
      prompt: string,
    ) => {
      prompts.push(prompt);
      return null;
    }) as typeof model.invokeStructured);

    await macroAgent.invokeProposeMacroAgent(ctx, baseInput, [
      "I want to run 6 days",
      "long run on Saturday",
    ]);

    expect(prompts[0]).toContain("ATHLETE FEEDBACK ON PRIOR DRAFTS");
    expect(prompts[0]).toContain("I want to run 6 days");
    expect(prompts[0]).toContain("long run on Saturday");
    spy.mockRestore();
  });
});

describe("extractPlanInputPatch", () => {
  it("maps an explicit request onto a planner-input patch", async () => {
    const spy = spyOn(model, "invokeStructured").mockResolvedValue({
      daysPerWeek: 6,
      preferredLongRunDay: 5,
      volumeAggressiveness: null,
      intensityAggressiveness: null,
      maxWeeklyVolumeMeters: null,
    });

    const patch = await extractPlanInputPatch(
      "I want to run 6 days, long run on Saturday",
      baseInput,
      "macro",
    );

    expect(patch).toEqual({ daysPerWeek: 6, preferredLongRunDay: 5 });
    spy.mockRestore();
  });

  it("maps a cross-training request onto the patch at the sessions gate", async () => {
    const spy = spyOn(model, "invokeStructured").mockResolvedValue({
      daysPerWeek: null,
      preferredLongRunDay: null,
      intensityAggressiveness: null,
      crossTrainingPerWeek: 1,
    });

    const patch = await extractPlanInputPatch("I need some elliptical work", baseInput, "sessions");

    expect(patch).toEqual({ crossTrainingPerWeek: 1 });
    spy.mockRestore();
  });

  it("yields an EMPTY patch for feedback with no structured intent", async () => {
    const spy = spyOn(model, "invokeStructured").mockResolvedValue({
      daysPerWeek: null,
      preferredLongRunDay: null,
      volumeAggressiveness: null,
      intensityAggressiveness: null,
      maxWeeklyVolumeMeters: null,
    });

    expect(await extractPlanInputPatch("this feels too hard", baseInput, "macro")).toEqual({});
    expect(
      await extractPlanInputPatch("I don't like the Tuesday session", baseInput, "macro"),
    ).toEqual({});
    spy.mockRestore();
  });

  it("degrades to an empty patch when extraction fails or returns null", async () => {
    const failing = spyOn(model, "invokeStructured").mockRejectedValue(new Error("boom"));
    expect(await extractPlanInputPatch("run 6 days", baseInput, "macro")).toEqual({});
    failing.mockRestore();

    const nulled = spyOn(model, "invokeStructured").mockResolvedValue(null);
    expect(await extractPlanInputPatch("run 6 days", baseInput, "macro")).toEqual({});
    nulled.mockRestore();
  });

  it("prompts the extractor to keep time-scoped feedback away from the global dials", async () => {
    const prompts: string[] = [];
    const spy = spyOn(model, "invokeStructured").mockImplementation((async (
      _schema,
      prompt: string,
    ) => {
      prompts.push(prompt);
      return null;
    }) as typeof model.invokeStructured);

    await extractPlanInputPatch("keep it lower intensity to start", baseInput, "macro");

    expect(prompts[0]).toContain("scoped to a PART of the plan");
    expect(prompts[0]).toContain('"to start"');
    expect(prompts[0]).toContain("volumeAggressiveness and intensityAggressiveness");
    expect(prompts[0]).toContain('"keep it easier to start" → all fields null');
    spy.mockRestore();
  });

  it("drops a value that already matches the current setting", async () => {
    const spy = spyOn(model, "invokeStructured").mockResolvedValue({
      daysPerWeek: 3,
      preferredLongRunDay: null,
      volumeAggressiveness: null,
      intensityAggressiveness: null,
      maxWeeklyVolumeMeters: null,
    });
    expect(await extractPlanInputPatch("keep it at 3 days", baseInput, "macro")).toEqual({});
    spy.mockRestore();
  });
});

describe("safety clamps refuse out loud", () => {
  it("emits a ramp notice instead of silently cutting the week", () => {
    const raw: PlanMacro = {
      name: "Aggressive",
      rationale: "athlete asked for more mileage",
      weeks: [1, 2, 3].map((weekIndex) => ({
        weekIndex,
        startDate: "ignored",
        phase: "build" as const,
        targetDistanceMeters: 40_000 * weekIndex ** 2,
        keySessions: [],
      })),
    };

    const { macro, notices } = shapeMacro(raw, baseInput, {
      baselineWeeklyMeters: 40_000,
      longestRunMeters: null,
      provenWeeklyMeters: null,
      provenLongestRunMeters: null,
      volumeAggressiveness: "steady",
      maxWeeklyVolumeMeters: null,
      raceDistanceMeters: null,
    });

    const ramp = notices.find((n) => n.code === "weekly_ramp_exceeded");
    expect(ramp).toBeDefined();
    expect(ramp?.kind).toBe("clamped");
    expect(ramp?.message).toContain("injury");
    expect((ramp?.limit ?? 0) < (ramp?.observed ?? 0)).toBe(true);
    // The refusal is real, not just narrated.
    expect(macro.weeks[1].targetDistanceMeters).toBeLessThan(raw.weeks[1].targetDistanceMeters);
  });

  it("emits a quality-cap notice when a base week cannot take another hard session", () => {
    const week: PlanMacroWeek = {
      weekIndex: 1,
      startDate: "2026-01-05",
      phase: "base",
      targetDistanceMeters: 40_000,
      keySessions: [],
    };
    const raw: GeneratedSession[] = [
      { date: "2026-01-06", sessionType: "LONG_INTERVALS", title: "5x1000m", structure: null },
      { date: "2026-01-08", sessionType: "TEMPO", title: "Tempo 20min", structure: null },
      { date: "2026-01-10", sessionType: "EASY", title: "Easy run", structure: null },
    ];

    const { sessions, notices } = assembleWeekSessionsWithNotices(week, raw, {
      intensityAggressiveness: "balanced",
      daysPerWeek: 5,
      preferredLongRunDay: null,
      crossTrainingCount: 0,
      crossTrainingInjuryDriven: false,
      raceDistanceMeters: null,
      provenWeeklyMeters: null,
    });

    const cap = notices.find((n) => n.code === "quality_sessions_exceeded");
    expect(cap).toBeDefined();
    expect(cap?.kind).toBe("clamped");
    expect(cap?.observed).toBe(2);
    expect(cap?.limit).toBe(0);
    expect(sessions.every((s) => s.sessionType === "EASY")).toBe(true);
  });

  // The Kim bug: the ramp notice quoted its own stage's value ("cut to 48.4 km")
  // while later stages (down week) lowered the printed week to 31.7 km.
  it("cites the FINAL week volume when a later stage lowers a ramp-clamped week further", () => {
    const raw: PlanMacro = {
      name: "P",
      rationale: "r",
      weeks: [30_000, 33_000, 36_300, 60_000, 43_000].map((targetDistanceMeters, i) => ({
        weekIndex: i + 1,
        startDate: "ignored",
        phase: "build" as const,
        targetDistanceMeters,
        keySessions: [],
      })),
    };

    const { macro, notices } = shapeMacro(
      raw,
      { startDate: "2026-01-05", endDate: "2026-02-08" },
      {
        baselineWeeklyMeters: 30_000,
        longestRunMeters: null,
        provenWeeklyMeters: null,
        provenLongestRunMeters: null,
        volumeAggressiveness: "steady",
        maxWeeklyVolumeMeters: null,
        raceDistanceMeters: null,
      },
    );

    // Ramp clamp bit week 4 (60 km), then enforceDownWeeks lowered it further
    // and quantization put the dip on the 2 km grid off its quantized neighbour.
    expect(macro.weeks[3].targetDistanceMeters).toBe(26_000);
    const ramp = notices.find((n) => n.code === "weekly_ramp_exceeded");
    expect(ramp?.weekIndex).toBe(4);
    expect(ramp?.observed).toBe(60_000);
    expect(ramp?.limit).toBe(26_000);
    expect(ramp?.message).toContain("26.0 km");
  });

  it("stays silent when nothing was refused", () => {
    const { notices } = shapeMacro(
      {
        name: "Sane",
        rationale: "steady",
        weeks: [1, 2, 3].map((weekIndex) => ({
          weekIndex,
          startDate: "ignored",
          phase: "build" as const,
          targetDistanceMeters: 40_000,
          keySessions: [],
        })),
      },
      baseInput,
      {
        baselineWeeklyMeters: 40_000,
        longestRunMeters: null,
        provenWeeklyMeters: null,
        provenLongestRunMeters: null,
        volumeAggressiveness: "steady",
        maxWeeklyVolumeMeters: null,
        raceDistanceMeters: null,
      },
    );
    expect(notices).toEqual([]);
  });
});

describe("feedback changes the guarded output (real graph)", () => {
  let userId: string;
  const spies: { mockRestore: () => void }[] = [];
  let nextIntent: Record<string, unknown> = {};
  const threads: string[] = [];

  const newThread = () => {
    const id = `plan-builder:${randomUUID()}`;
    threads.push(id);
    return id;
  };
  const config = (threadId: string) => ({ configurable: { thread_id: threadId, db: getDb() } });

  const macro = (): PlanMacro => ({
    name: "Stub Plan",
    rationale: "base into build",
    weeks: [1, 2, 3].map((weekIndex) => ({
      weekIndex,
      startDate: "ignored",
      phase: "build" as const,
      targetDistanceMeters: 40_000,
      keySessions: [],
    })),
  });

  // Seven easy days a week, so the only thing deciding the session count is the
  // athlete's run-day setting — exactly the value feedback is meant to move.
  const sessions = (): GenerateSessionsOutput => ({
    weeks: [1, 2, 3].map((weekIndex) => ({
      weekIndex,
      sessions: Array.from({ length: 7 }, (_, d) => ({
        date: `2026-01-${String(5 + d).padStart(2, "0")}`,
        sessionType: "EASY" as const,
        title: "Easy run",
        structure: null,
      })),
    })),
  });

  const weekOneCount = (state: { values: Record<string, unknown> }) =>
    (state.values.sessionsByWeek as { weekIndex: number; sessions: unknown[] }[])[0].sessions.length;

  const payloadOf = async (graph: Awaited<ReturnType<typeof buildPlanBuilderGraph>>, t: string) => {
    const state = await graph.getState(config(t));
    return state.tasks.flatMap((task) => task.interrupts)[0]?.value as Record<string, unknown>;
  };

  beforeAll(async () => {
    userId = (await createTestUser({ intervals: false })).id;
    spies.push(spyOn(macroAgent, "invokeProposeMacroAgent").mockResolvedValue(macro()));
    spies.push(spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockResolvedValue(sessions()));
    spies.push(
      spyOn(model, "invokeStructured").mockImplementation((async () =>
        nextIntent) as typeof model.invokeStructured),
    );
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    for (const t of threads) await resetPlanBuilderThread(t).catch(() => {});
    await deleteTestUser(userId);
  });

  it("'I want to run 6 days' overrides the wizard form and survives to the output", async () => {
    const graph = await buildPlanBuilderGraph();
    const thread = newThread();
    await resetPlanBuilderThread(thread);

    nextIntent = {
      daysPerWeek: null,
      preferredLongRunDay: null,
      volumeAggressiveness: null,
      intensityAggressiveness: null,
      maxWeeklyVolumeMeters: null,
    };
    await graph.invoke({ userId, input: baseInput }, config(thread));
    await graph.invoke(new Command({ resume: { action: "accept" } }), config(thread));

    // The form said 3 run days, and that is what the guards enforced.
    expect(weekOneCount(await graph.getState(config(thread)))).toBe(3);

    nextIntent = { daysPerWeek: 6, preferredLongRunDay: null, intensityAggressiveness: null };
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "I want to run 6 days" } }),
      config(thread),
    );

    const state = await graph.getState(config(thread));
    expect((state.values.input as PlanBuilderInput).daysPerWeek).toBe(6);
    expect(weekOneCount(state)).toBe(6);

    const payload = await payloadOf(graph, thread);
    const applied = (payload.notices as PlanNotice[]).find((n) => n.kind === "applied");
    expect(applied?.code).toBe("daysPerWeek");
    expect(applied?.message).toContain("6");
  });

  it("'I need some elliptical work' adds a cross-training session to the output", async () => {
    const graph = await buildPlanBuilderGraph();
    const thread = newThread();
    await resetPlanBuilderThread(thread);

    nextIntent = {};
    await graph.invoke({ userId, input: baseInput }, config(thread));
    await graph.invoke(new Command({ resume: { action: "accept" } }), config(thread));

    const before = await graph.getState(config(thread));
    const titlesBefore = (
      before.values.sessionsByWeek as { sessions: { title: string }[] }[]
    )[0].sessions.map((s) => s.title);
    expect(titlesBefore).not.toContain(CROSS_TRAINING_TITLE);

    nextIntent = {
      daysPerWeek: null,
      preferredLongRunDay: null,
      intensityAggressiveness: null,
      crossTrainingPerWeek: 1,
    };
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "I need some elliptical work" } }),
      config(thread),
    );

    const state = await graph.getState(config(thread));
    expect((state.values.input as PlanBuilderInput).crossTrainingPerWeek).toBe(1);
    const week1 = (state.values.sessionsByWeek as { sessions: { title: string }[] }[])[0];
    expect(week1.sessions.filter((s) => s.title === CROSS_TRAINING_TITLE)).toHaveLength(1);

    const payload = await payloadOf(graph, thread);
    const applied = (payload.notices as PlanNotice[]).find((n) => n.kind === "applied");
    expect(applied?.code).toBe("crossTrainingPerWeek");
  });

  it("acknowledges a feedback round whose patch is empty with a prose-only notice", async () => {
    const graph = await buildPlanBuilderGraph();
    const thread = newThread();
    await resetPlanBuilderThread(thread);

    nextIntent = {
      daysPerWeek: null,
      preferredLongRunDay: null,
      volumeAggressiveness: null,
      intensityAggressiveness: null,
      maxWeeklyVolumeMeters: null,
    };
    await graph.invoke({ userId, input: baseInput }, config(thread));
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "make week 1 about 5 km" } }),
      config(thread),
    );

    const state = await graph.getState(config(thread));
    const stateNotices = state.values.feedbackNotices as PlanNotice[];
    expect(stateNotices).toHaveLength(1);
    expect(stateNotices[0].code).toBe("feedback_prose_only");
    expect(stateNotices[0].kind).toBe("applied");

    const payload = await payloadOf(graph, thread);
    const notice = (payload.notices as PlanNotice[]).find((n) => n.code === "feedback_prose_only");
    expect(notice?.kind).toBe("applied");
    expect(notice?.message).toContain("passed to the coach");

    // The sessions gate owes the same acknowledgment.
    await graph.invoke(new Command({ resume: { action: "accept" } }), config(thread));
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "the Tuesday run feels wrong" } }),
      config(thread),
    );
    const sessionsPayload = await payloadOf(graph, thread);
    expect((sessionsPayload.notices as PlanNotice[]).map((n) => n.code)).toContain(
      "feedback_prose_only",
    );
  });

  it("surfaces guard notices and a per-week summary in the review payloads", async () => {
    const graph = await buildPlanBuilderGraph();
    const thread = newThread();
    await resetPlanBuilderThread(thread);

    nextIntent = {};
    await graph.invoke({ userId, input: baseInput }, config(thread));

    const macroPayload = await payloadOf(graph, thread);
    expect(macroPayload.phase).toBe("macro_review");
    expect(Array.isArray(macroPayload.notices)).toBe(true);
    expect(macroPayload.maxRounds).toBe(MAX_REVIEW_ROUNDS);

    await graph.invoke(new Command({ resume: { action: "accept" } }), config(thread));
    const sessionsPayload = await payloadOf(graph, thread);
    expect(sessionsPayload.phase).toBe("sessions_review");
    // Every week is represented, not just one sample week.
    expect((sessionsPayload.weeks as unknown[]).length).toBe(3);
    expect(sessionsPayload.sampleWeek).toBeTruthy();
    expect((sessionsPayload.totals as { sessions: number }).sessions).toBe(9);
  });

  it("caps the adjust loop and says so instead of looping forever", async () => {
    const graph = await buildPlanBuilderGraph();
    const thread = newThread();
    await resetPlanBuilderThread(thread);

    nextIntent = {};
    await graph.invoke({ userId, input: baseInput }, config(thread));

    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      await graph.invoke(
        new Command({ resume: { action: "adjust", feedback: `round ${i}` } }),
        config(thread),
      );
      const state = await graph.getState(config(thread));
      expect(state.next).toContain("macroReview");
    }

    // One more adjust: refused, and the graph moves on rather than regenerating.
    await graph.invoke(
      new Command({ resume: { action: "adjust", feedback: "one more time" } }),
      config(thread),
    );

    const state = await graph.getState(config(thread));
    expect(state.next).toContain("sessionsReview");
    expect((state.values.macroFeedback as string[]).length).toBe(MAX_REVIEW_ROUNDS);

    const notices = (await payloadOf(graph, thread)).notices as PlanNotice[];
    const capped = notices.find((n) => n.code === "review_rounds_exhausted");
    expect(capped?.kind).toBe("clamped");
    expect(capped?.message).toContain(String(MAX_REVIEW_ROUNDS));
  });
});
