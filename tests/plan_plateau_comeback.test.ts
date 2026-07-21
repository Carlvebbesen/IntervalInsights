import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import {
  assembleWeekSessionsWithNotices,
  capLongestRunSpike,
  clampRampAgainstPeak,
  clampWeeklyRamp,
  type MacroShapingParams,
  MIN_FILL_RUN_METERS,
  PLATEAU_BAND,
  quantizeWeeklyTargets,
  shapeMacro,
  VOLUME_RAMP,
} from "../src/agent/planning/guards";
import { invokeProposeMacroAgent } from "../src/agent/planning/plan_macro_agent";
import { invokeGenerateSessionsAgent } from "../src/agent/planning/plan_sessions_agent";
import type {
  GeneratedSession,
  PlanMacro,
  PlanMacroWeek,
} from "../src/agent/planning/plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "../src/agent/planning/plan_builder_state";

// The owner's reference plans hold plateaus and take visible steps (50, 50, 60,
// 70 …), a comeback athlete returns toward proven capacity instead of building
// like a novice, and an experienced athlete never gets 2–3 km filler runs.

// ── Item 1: plateau-and-step quantization ────────────────────────────────────

describe("quantizeWeeklyTargets", () => {
  const progressive = VOLUME_RAMP.progressive;

  it("turns a smooth ramp into visible steps and plateaus (deltas 0 or ≥ grid)", () => {
    const smooth = [14000, 15000, 16100, 11600, 17200, 18400, 19700];
    const out = quantizeWeeklyTargets(smooth, {
      ceiling: progressive.ceiling,
      burst: progressive.burst,
      maxWeeklyVolumeMeters: null,
      longestRunMeters: null,
      downWeekIndices: new Set([3]),
      taperStartIndex: smooth.length,
    });
    expect(out).toEqual([14000, 16000, 16000, 12000, 18000, 18000, 20000]);
    const deltas = out
      .map((v, i) => (i > 0 ? Math.abs(v - out[i - 1]) : 0))
      .filter((d, i) => i > 0);
    for (const d of deltas) expect(d === 0 || d >= 2000).toBe(true);
  });

  it("leaves the taper region untouched and re-grids the down week off its quantized neighbour", () => {
    const out = quantizeWeeklyTargets([20000, 21100, 15190, 16880, 12660], {
      ceiling: VOLUME_RAMP.steady.ceiling,
      burst: VOLUME_RAMP.steady.burst,
      maxWeeklyVolumeMeters: null,
      longestRunMeters: null,
      downWeekIndices: new Set([2]),
      taperStartIndex: 3,
    });
    // Down week = 0.72 × the quantized 22 km neighbour → 15.84 → 16 km grid;
    // the taper tail (indices 3+) is byte-identical.
    expect(out[2]).toBe(16000);
    expect(out.slice(3)).toEqual([16880, 12660]);
  });

  it("flattens sub-band noise but never a step the underlying trajectory earned", () => {
    // 20 → 21.1 rounds to 22 (a 10% step, above the 8% band): kept.
    // 20 → 20.9 rounds to 20 (same grid point): an exact plateau.
    const stepped = quantizeWeeklyTargets([20000, 21100], {
      ceiling: VOLUME_RAMP.steady.ceiling,
      burst: VOLUME_RAMP.steady.burst,
      maxWeeklyVolumeMeters: null,
      longestRunMeters: null,
      downWeekIndices: new Set(),
      taperStartIndex: 2,
    });
    expect(stepped).toEqual([20000, 22000]);
    expect(PLATEAU_BAND).toBe(0.08);
  });
});

// ── Item 2: proven capacity drives the comeback ramp ─────────────────────────

describe("comeback return lane (proven capacity)", () => {
  it("clampWeeklyRamp allows 30% below 85% of proven, then shuts off", () => {
    // threshold = 0.85 × 30000 = 25500
    expect(clampWeeklyRamp([20000, 40000, 40000, 40000], 0.07, 0.07, 30000)).toEqual([
      20000, 25500, 27285, 29195,
    ]);
    expect(clampWeeklyRamp([20000, 40000], 0.07, 0.07)).toEqual([20000, 21400]);
  });

  it("clampRampAgainstPeak honours the same lane via opts", () => {
    expect(
      clampRampAgainstPeak([20000, 40000], 0.07, 0.07, { provenWeeklyMeters: 30000 }),
    ).toEqual([20000, 25500]);
    expect(clampRampAgainstPeak([20000, 40000], 0.07, 0.07)).toEqual([20000, 21400]);
  });

  it("capLongestRunSpike references 80% of the proven longest when it beats the recent longest", () => {
    // ref = max(5000, 0.8 × 18000) = 14400 → week-0 ceiling 14400 × 1.3 / 0.35
    expect(capLongestRunSpike([80000], 5000, 18000)).toEqual([53486]);
    expect(capLongestRunSpike([80000], 5000)).toEqual([18571]);
  });

  const rawMacro = (weeks: number, target: number): PlanMacro => ({
    name: "P",
    rationale: "r",
    weeks: Array.from({ length: weeks }, (_, i) => ({
      weekIndex: i + 1,
      startDate: "ignored",
      phase: "build" as const,
      targetDistanceMeters: target,
      keySessions: [],
    })),
  });
  const tenWeeks: PlanBuilderInput = { startDate: "2026-01-05", endDate: "2026-03-09" };
  const params = (over: Partial<MacroShapingParams> = {}): MacroShapingParams => ({
    baselineWeeklyMeters: 15000,
    longestRunMeters: null,
    provenWeeklyMeters: null,
    provenLongestRunMeters: null,
    volumeAggressiveness: "gradual",
    maxWeeklyVolumeMeters: null,
    raceDistanceMeters: null,
    ...over,
  });

  it("a comeback athlete (proven 40 km) reaches ≥30 km within 10 weeks at gradual; a no-history athlete stays on the novice curve", () => {
    const comeback = shapeMacro(
      rawMacro(10, 60000),
      tenWeeks,
      params({ provenWeeklyMeters: 40000 }),
    ).macro;
    expect(comeback.weeks.map((w) => w.targetDistanceMeters)).toEqual([
      14000, 18000, 22000, 16000, 28000, 30000, 35000, 26000, 40000, 45000,
    ]);
    expect(Math.max(...comeback.weeks.map((w) => w.targetDistanceMeters))).toBeGreaterThanOrEqual(
      30000,
    );

    const novice = shapeMacro(rawMacro(10, 60000), tenWeeks, params()).macro;
    expect(novice.weeks.map((w) => w.targetDistanceMeters)).toEqual([
      14000, 16000, 16000, 12000, 18000, 20000, 22000, 16000, 24000, 26000,
    ]);
    expect(Math.max(...novice.weeks.map((w) => w.targetDistanceMeters))).toBeLessThan(30000);
  });
});

// ── Item 3: minimum meaningful run distance (session consolidation) ──────────

describe("short-run consolidation (assembleWeekSessionsWithNotices)", () => {
  const week = (targetDistanceMeters: number): PlanMacroWeek => ({
    weekIndex: 2,
    startDate: "2026-01-05",
    phase: "build",
    targetDistanceMeters,
    notes: null,
    keySessions: [],
  });
  const sess = (date: string, sessionType: GeneratedSession["sessionType"]): GeneratedSession => ({
    date,
    sessionType,
    title: sessionType,
    description: null,
    structure: null,
  });
  const smallWeek = () => [
    sess("2026-01-05", "EASY"),
    sess("2026-01-07", "EASY"),
    sess("2026-01-09", "EASY"),
    sess("2026-01-11", "LONG"),
  ];
  const params = (over: Partial<Parameters<typeof assembleWeekSessionsWithNotices>[2]> = {}) => ({
    intensityAggressiveness: "balanced" as const,
    daysPerWeek: 4,
    preferredLongRunDay: null,
    crossTrainingCount: 0,
    crossTrainingInjuryDriven: false,
    raceDistanceMeters: null,
    provenWeeklyMeters: null,
    ...over,
  });

  const hintedMeters = (s: GeneratedSession) =>
    Math.round(Number.parseFloat(/~([\d.]+) km/.exec(s.description ?? "")?.[1] ?? "0") * 1000);

  it("consolidates an experienced athlete's 14 km week so every run is ≥5 km, with a notice", () => {
    const { sessions, notices } = assembleWeekSessionsWithNotices(
      week(14000),
      smallWeek(),
      params({ provenWeeklyMeters: 20000 }),
    );
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.length).toBeLessThanOrEqual(3);
    for (const s of sessions) expect(hintedMeters(s)).toBeGreaterThanOrEqual(MIN_FILL_RUN_METERS);
    const notice = notices.find((n) => n.code === "short_runs_consolidated");
    expect(notice?.kind).toBe("clamped");
    expect(notice?.observed).toBe(4);
    expect(notice?.limit).toBe(sessions.length);
    expect(notice?.message).toContain("meaningful distance");
  });

  it("a beginner (no proven history) keeps the short run-walk sized runs", () => {
    const { sessions, notices } = assembleWeekSessionsWithNotices(week(14000), smallWeek(), params());
    expect(sessions).toHaveLength(4);
    expect(notices.find((n) => n.code === "short_runs_consolidated")).toBeUndefined();
  });

  it("an injured athlete is exempt even with proven history", () => {
    const { sessions, notices } = assembleWeekSessionsWithNotices(
      week(14000),
      smallWeek(),
      params({ provenWeeklyMeters: 20000, crossTrainingCount: 1, crossTrainingInjuryDriven: true }),
    );
    expect(sessions).toHaveLength(4);
    expect(notices.find((n) => n.code === "short_runs_consolidated")).toBeUndefined();
  });

  it("leaves an experienced week alone when every fill run is already meaningful", () => {
    const { sessions, notices } = assembleWeekSessionsWithNotices(
      week(40000),
      smallWeek(),
      params({ provenWeeklyMeters: 20000, daysPerWeek: 5 }),
    );
    expect(sessions).toHaveLength(4);
    expect(notices.find((n) => n.code === "short_runs_consolidated")).toBeUndefined();
    // The weighted-split invariants still hold: recovery < easy < long ordering
    // is covered by the existing fill tests; here every run clears the floor.
    for (const s of sessions) expect(hintedMeters(s)).toBeGreaterThanOrEqual(MIN_FILL_RUN_METERS);
  });
});

// ── Items 2 + 4: prompt alignment ────────────────────────────────────────────

const ctx = (over: Partial<AthleteContext> = {}): AthleteContext => ({
  athleteName: "Tester",
  maxHeartRate: 190,
  intervalsConnected: false,
  race: null,
  recentWeeks: [],
  fitness: null,
  raceAbility: null,
  baselineVolume: null,
  activeHealthEvents: [],
  workoutVocabulary: { types: [], hasStructuredIntervalHistory: false, structures: [] },
  ...over,
});

describe("plateau + comeback prompt content", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function capturePrompt() {
    const prompts: string[] = [];
    spies.push(
      spyOn(model, "invokeStructured").mockImplementation((async (_schema, prompt: string) => {
        prompts.push(prompt);
        return null;
      }) as typeof model.invokeStructured),
    );
    return prompts;
  }

  const input: PlanBuilderInput = { startDate: "2026-01-05", endDate: "2026-01-25" };

  it("macro prompt carries the plateau-and-step and comeback hard rules", async () => {
    const prompts = capturePrompt();
    await invokeProposeMacroAgent(ctx(), input, []);
    expect(prompts[0]).toContain("then take a visible step");
    expect(prompts[0]).toContain("quantizes");
    expect(prompts[0]).toContain("RETURN toward it substantially faster");
  });

  it("macro prompt renders the proven-capacity line only when proven exceeds trailing", async () => {
    const withProven = capturePrompt();
    await invokeProposeMacroAgent(
      ctx({
        baselineVolume: {
          trailing4WeekAvgWeeklyMeters: 15000,
          longestRunLast30dMeters: 8000,
          provenWeeklyMeters: 38000,
          provenLongestRunMeters: 18000,
        },
      }),
      input,
      [],
    );
    expect(withProven[0]).toContain("Proven capacity (last 6 months): ~38.0 km/week");
    expect(withProven[0]).toContain("longest run 18.0 km");
    expect(withProven[0]).toContain("week 1 still anchors to the current baseline");

    for (const s of spies.splice(0)) s.mockRestore();
    const atCapacity = capturePrompt();
    await invokeProposeMacroAgent(
      ctx({
        baselineVolume: {
          trailing4WeekAvgWeeklyMeters: 40000,
          longestRunLast30dMeters: 16000,
          provenWeeklyMeters: 38000,
          provenLongestRunMeters: 18000,
        },
      }),
      input,
      [],
    );
    expect(atCapacity[0]).not.toContain("Proven capacity");
  });

  it("sessions prompt carries the no-short-runs rule for experienced athletes", async () => {
    const prompts = capturePrompt();
    await invokeGenerateSessionsAgent(
      ctx(),
      [
        {
          weekIndex: 1,
          startDate: "2026-01-05",
          phase: "build",
          targetDistanceMeters: 40000,
          keySessions: [],
        },
      ],
      [],
    );
    expect(prompts[0]).toContain("never propose a run shorter than 5 km");
    expect(prompts[0]).toContain("fewer, meaningful sessions");
  });
});
