import { describe, expect, it } from "bun:test";
import {
  anchorWeekOne,
  applyTaper,
  capLongestRunSpike,
  capMaxWeekly,
  clampVolumeRamp,
  clampWeeklyRamp,
  CROSS_TRAINING_TITLE,
  DEFAULT_BASELINE_WEEKLY_METERS,
  DEFAULT_DAYS_PER_WEEK,
  EASY_PACE_MPS,
  enforceDaysPerWeek,
  enforceDownWeeks,
  enforceQualityCount,
  estimateStructureDistanceMeters,
  expectedWeekStarts,
  isHardSession,
  longRunOffset,
  type MacroShapingParams,
  placeLongRun,
  qualityCap,
  repairMacro,
  repairSessionDate,
  resolveDaysPerWeek,
  spaceHardSessions,
  stripPaces,
  substituteCrossTraining,
  taperWeekCount,
  VOLUME_RAMP,
} from "../src/agent/planning/guards";
import type { GeneratedSession, PlanMacro, PlanMacroWeek } from "../src/agent/planning/plan_builder_schemas";
import type { PlanBuilderInput } from "../src/agent/planning/plan_builder_state";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";

describe("expectedWeekStarts (Monday alignment)", () => {
  it("covers a mid-week start and end with partial first/last weeks", () => {
    // 2026-01-01 is a Thursday; 2026-01-14 a Wednesday.
    expect(expectedWeekStarts("2026-01-01", "2026-01-14")).toEqual([
      "2025-12-29",
      "2026-01-05",
      "2026-01-12",
    ]);
  });

  it("returns a single week when the range sits inside one Mon–Sun", () => {
    expect(expectedWeekStarts("2026-01-05", "2026-01-11")).toEqual(["2026-01-05"]);
  });

  it("is inclusive of the week containing endDate", () => {
    expect(expectedWeekStarts("2026-01-05", "2026-01-12")).toEqual(["2026-01-05", "2026-01-12"]);
  });
});

describe("clampVolumeRamp", () => {
  it("clamps week-over-week growth to +20%", () => {
    expect(clampVolumeRamp([10000, 30000, 20000, 40000])).toEqual([10000, 12000, 14400, 17280]);
  });

  it("lets recovery drops through untouched", () => {
    expect(clampVolumeRamp([10000, 12000, 8000, 9000])).toEqual([10000, 12000, 8000, 9000]);
  });
});

describe("repairSessionDate", () => {
  const weekStart = "2026-01-05"; // Mon; week is 2026-01-05..2026-01-11

  it("clamps a date before the week to the week start", () => {
    expect(repairSessionDate("2026-01-03", weekStart)).toBe("2026-01-05");
  });

  it("clamps a date after the week to the week end", () => {
    expect(repairSessionDate("2026-01-15", weekStart)).toBe("2026-01-11");
  });

  it("leaves an in-range date untouched", () => {
    expect(repairSessionDate("2026-01-08", weekStart)).toBe("2026-01-08");
  });
});

describe("stripPaces", () => {
  it("nulls every target_pace / target_paces", () => {
    const structure: WorkoutStructureSet[] = [
      {
        set_reps: 1,
        steps: [
          { reps: 5, work_type: "DISTANCE", work_value: 1000, target_pace: 210, target_paces: [210] },
        ],
      },
    ];
    const out = stripPaces(structure);
    expect(out?.[0].steps[0].target_pace).toBeNull();
    expect(out?.[0].steps[0].target_paces).toBeNull();
  });

  it("returns null for null/undefined structure", () => {
    expect(stripPaces(null)).toBeNull();
    expect(stripPaces(undefined)).toBeNull();
  });
});

describe("estimateStructureDistanceMeters", () => {
  it("sums DISTANCE work + recovery across reps", () => {
    const structure: WorkoutStructureSet[] = [
      {
        set_reps: 1,
        steps: [
          {
            reps: 5,
            work_type: "DISTANCE",
            work_value: 1000,
            recovery_type: "DISTANCE",
            recovery_value: 200,
            target_pace: null,
          },
        ],
      },
    ];
    expect(estimateStructureDistanceMeters(structure)).toBe(6000);
  });

  it("approximates TIME work at easy pace", () => {
    const structure: WorkoutStructureSet[] = [
      { set_reps: 1, steps: [{ reps: 4, work_type: "TIME", work_value: 60, target_pace: null }] },
    ];
    expect(estimateStructureDistanceMeters(structure)).toBe(Math.round(4 * 60 * EASY_PACE_MPS));
  });

  it("returns 0 for a structureless session", () => {
    expect(estimateStructureDistanceMeters(null)).toBe(0);
  });
});

describe("anchorWeekOne", () => {
  it("forces week 1 to the real baseline, never the LLM's goal week", () => {
    expect(anchorWeekOne([30000, 34000, 36000], 42000)).toEqual([42000, 34000, 36000]);
  });

  it("falls back to the conservative floor when there is no history", () => {
    expect(anchorWeekOne([30000], null)).toEqual([DEFAULT_BASELINE_WEEKLY_METERS]);
  });

  // The 20 km floor is for NO data, not for little data — applying it to a real
  // low-volume athlete anchors them above what they actually run.
  it("keeps a small real baseline instead of inflating it to the floor", () => {
    expect(anchorWeekOne([30000], 2500)).toEqual([2500]);
    expect(anchorWeekOne([30000], 4000)).toEqual([4000]);
  });

  it("still uses the floor for a zero or non-finite baseline", () => {
    expect(anchorWeekOne([30000], 0)).toEqual([DEFAULT_BASELINE_WEEKLY_METERS]);
    expect(anchorWeekOne([30000], Number.NaN)).toEqual([DEFAULT_BASELINE_WEEKLY_METERS]);
  });

  it("no-ops on an empty plan", () => {
    expect(anchorWeekOne([], 40000)).toEqual([]);
  });
});

describe("clampWeeklyRamp (per-axis ceilings)", () => {
  it("gradual: clamps every increase to +7%", () => {
    const { ceiling, burst } = VOLUME_RAMP.gradual;
    expect(clampWeeklyRamp([20000, 30000, 30000], ceiling, burst)).toEqual([20000, 21400, 22898]);
  });

  it("steady: clamps every increase to +10%", () => {
    const { ceiling, burst } = VOLUME_RAMP.steady;
    expect(clampWeeklyRamp([20000, 30000], ceiling, burst)).toEqual([20000, 22000]);
  });

  it("progressive: tolerates one +25% burst then forces +15%", () => {
    const { ceiling, burst } = VOLUME_RAMP.progressive;
    expect(clampWeeklyRamp([20000, 30000, 30000, 30000], ceiling, burst)).toEqual([
      20000, 25000, 28750, 30000,
    ]);
  });

  it("legacy clampVolumeRamp still holds the flat +20% contract", () => {
    expect(clampVolumeRamp([10000, 30000, 20000, 40000])).toEqual([10000, 12000, 14400, 17280]);
  });
});

describe("capLongestRunSpike", () => {
  it("scales weeks down so the implied long run cannot spike past +30% (growing)", () => {
    expect(capLongestRunSpike([50000, 50000], 10000)).toEqual([37143, 40857]);
  });

  it("no-ops without a known recent longest run", () => {
    expect(capLongestRunSpike([50000], null)).toEqual([50000]);
  });
});

describe("enforceDownWeeks", () => {
  it("drops every 4th build week to ~72% of the prior week", () => {
    expect(
      enforceDownWeeks([10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000]),
    ).toEqual([10000, 11000, 12000, 8640, 14000, 15000, 16000, 11520]);
  });

  it("leaves taper-region weeks (beyond buildWeeks) untouched", () => {
    expect(
      enforceDownWeeks([10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000], 5),
    ).toEqual([10000, 11000, 12000, 8640, 14000, 15000, 16000, 17000]);
  });
});

describe("capMaxWeekly", () => {
  it("hard-caps every week at the user's ceiling", () => {
    expect(capMaxWeekly([30000, 40000, 50000], 45000)).toEqual([30000, 40000, 45000]);
  });

  it("no-ops when no ceiling is set", () => {
    expect(capMaxWeekly([30000], null)).toEqual([30000]);
  });
});

describe("taperWeekCount (by race distance)", () => {
  it("marathon → 3 weeks", () => expect(taperWeekCount(42195)).toBe(3));
  it("half → 2 weeks", () => expect(taperWeekCount(21097)).toBe(2));
  it("10k → 1 week", () => expect(taperWeekCount(10000)).toBe(1));
  it("no race → 0 weeks", () => expect(taperWeekCount(null)).toBe(0));
});

describe("applyTaper (staged tail volumes + phases)", () => {
  const wk = (targetDistanceMeters: number): PlanMacroWeek => ({
    weekIndex: 0,
    startDate: "2026-01-05",
    phase: "build",
    targetDistanceMeters,
    notes: null,
    keySessions: [],
  });

  it("marathon (3 weeks): −20/−40/−60% off the last build week, taper→taper→race", () => {
    const weeks = [30000, 32000, 34000, 40000, 40000, 40000].map(wk);
    const out = applyTaper(weeks, 3, true);
    expect(out.map((w) => w.targetDistanceMeters)).toEqual([
      30000, 32000, 34000, 27200, 20400, 13600,
    ]);
    expect(out.map((w) => w.phase)).toEqual(["build", "build", "build", "taper", "taper", "race"]);
  });

  it("half (2 weeks): staged off the last build week, final week race", () => {
    const weeks = [20000, 25000, 30000, 30000].map(wk);
    const out = applyTaper(weeks, 2, true);
    expect(out.map((w) => w.targetDistanceMeters)).toEqual([20000, 25000, 18750, 13750]);
    expect(out.map((w) => w.phase)).toEqual(["build", "build", "taper", "race"]);
  });

  it("10k (1 week): single staged race week", () => {
    const weeks = [20000, 24000, 28000].map(wk);
    const out = applyTaper(weeks, 1, true);
    expect(out.map((w) => w.targetDistanceMeters)).toEqual([20000, 24000, 14400]);
    expect(out.at(-1)?.phase).toBe("race");
  });

  it("non-race anchored: tail is taper, never race", () => {
    const out = applyTaper([20000, 24000, 28000].map(wk), 1, false);
    expect(out.at(-1)?.phase).toBe("taper");
  });
});

describe("repairMacro (orchestrated volume shaping)", () => {
  const rawMacro = (targets: number[]): PlanMacro => ({
    name: "P",
    rationale: "r",
    weeks: targets.map((targetDistanceMeters, i) => ({
      weekIndex: i + 1,
      startDate: "ignored",
      phase: "build" as const,
      targetDistanceMeters,
      keySessions: [],
    })),
  });

  const params = (over: Partial<MacroShapingParams> = {}): MacroShapingParams => ({
    baselineWeeklyMeters: 30000,
    longestRunMeters: null,
    volumeAggressiveness: "steady",
    maxWeeklyVolumeMeters: null,
    raceDistanceMeters: null,
    ...over,
  });

  const timeframeInput: PlanBuilderInput = { startDate: "2026-01-05", endDate: "2026-01-25" };

  it("anchors week 1 to the real baseline and steady-clamps the ramp", () => {
    const macro = repairMacro(rawMacro([60000, 70000, 80000]), timeframeInput, params());
    expect(macro.weeks.map((w) => w.targetDistanceMeters)).toEqual([30000, 33000, 36300]);
    expect(macro.weeks.map((w) => w.startDate)).toEqual([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
    ]);
  });

  it("applies maxWeeklyVolumeMeters as a final hard cap", () => {
    const macro = repairMacro(
      rawMacro([60000, 70000, 80000]),
      timeframeInput,
      params({ maxWeeklyVolumeMeters: 32000 }),
    );
    expect(macro.weeks.map((w) => w.targetDistanceMeters)).toEqual([30000, 32000, 32000]);
  });

  it("race-anchored: shapes a marathon taper onto the tail", () => {
    const raceInput: PlanBuilderInput = {
      startDate: "2026-01-05",
      endDate: "2026-02-15",
      raceEventId: 5,
    };
    const macro = repairMacro(
      rawMacro([40000, 40000, 40000, 40000, 40000, 40000]),
      raceInput,
      params({ baselineWeeklyMeters: 40000, raceDistanceMeters: 42195 }),
    );
    expect(macro.weeks.map((w) => w.targetDistanceMeters)).toEqual([
      40000, 40000, 40000, 32000, 24000, 16000,
    ]);
    expect(macro.weeks.at(-1)?.phase).toBe("race");
    expect(macro.weeks[3].phase).toBe("taper");
  });
});

// ── Session-level guards ─────────────────────────────────────────────────────

const struct = () => [
  { set_reps: 1, steps: [{ reps: 4, work_type: "TIME" as const, work_value: 60, target_pace: null }] },
];
const sess = (
  date: string,
  sessionType: GeneratedSession["sessionType"],
  structured = false,
): GeneratedSession => ({
  date,
  sessionType,
  title: sessionType,
  description: null,
  structure: structured ? struct() : null,
});
const hardCount = (ss: GeneratedSession[]) =>
  ss.filter((s) => isHardSession(s.sessionType, s.structure)).length;

describe("isHardSession", () => {
  it("classifies interval / tempo / progressive-long types as hard", () => {
    for (const t of ["TEMPO", "LONG_INTERVALS", "SHORT_INTERVALS", "HILL_SPRINTS", "SPRINTS", "FARTLEK", "PROGRESSIVE_LONG"] as const) {
      expect(isHardSession(t, null)).toBe(true);
    }
  });

  it("classifies easy / recovery / long / race as not hard", () => {
    for (const t of ["EASY", "RECOVERY", "LONG", "RACE"] as const) {
      expect(isHardSession(t, null)).toBe(false);
    }
  });

  it("treats a structured non-easy session as hard (defensive), but not a structured easy run", () => {
    expect(isHardSession("OTHER", struct())).toBe(true);
    expect(isHardSession("EASY", struct())).toBe(false);
  });
});

describe("qualityCap (per-phase / intensity axis)", () => {
  it("balanced: base 0, build 2, peak 3, taper 1, race 1", () => {
    expect(qualityCap("base", "balanced")).toBe(0);
    expect(qualityCap("build", "balanced")).toBe(2);
    expect(qualityCap("peak", "balanced")).toBe(3);
    expect(qualityCap("taper", "balanced")).toBe(1);
    expect(qualityCap("race", "balanced")).toBe(1);
  });

  it("comfortable shifts −1 with a floor of 0", () => {
    expect(qualityCap("build", "comfortable")).toBe(1);
    expect(qualityCap("base", "comfortable")).toBe(0);
  });

  it("challenging shifts +1, capped at 3 except peak reaches 4", () => {
    expect(qualityCap("build", "challenging")).toBe(3);
    expect(qualityCap("peak", "challenging")).toBe(4);
    expect(qualityCap("taper", "challenging")).toBe(2);
  });
});

describe("enforceQualityCount", () => {
  it("downgrades the excess (latest) hard sessions to easy runs", () => {
    const week = [
      sess("2026-01-05", "LONG_INTERVALS", true),
      sess("2026-01-07", "TEMPO", true),
      sess("2026-01-09", "SHORT_INTERVALS", true),
    ];
    const out = enforceQualityCount(week, "build", "balanced"); // cap 2
    expect(hardCount(out)).toBe(2);
    const downgraded = out.find((s) => s.sessionType === "EASY");
    expect(downgraded?.date).toBe("2026-01-09");
    expect(downgraded?.structure).toBeNull();
  });

  it("base phase (cap 0) downgrades all hard work to easy", () => {
    const out = enforceQualityCount([sess("2026-01-06", "TEMPO", true)], "base", "balanced");
    expect(hardCount(out)).toBe(0);
  });

  it("never fabricates hard work when below the cap", () => {
    const week = [sess("2026-01-06", "TEMPO", true), sess("2026-01-08", "EASY")];
    const out = enforceQualityCount(week, "build", "balanced"); // cap 2, only 1 hard
    expect(hardCount(out)).toBe(1);
  });
});

describe("spaceHardSessions", () => {
  it("moves a hard session off a day adjacent to another hard session", () => {
    const week = [
      sess("2026-01-05", "TEMPO", true),
      sess("2026-01-06", "LONG_INTERVALS", true),
      sess("2026-01-08", "EASY"),
    ];
    const out = spaceHardSessions(week);
    const hardDates = out
      .filter((s) => isHardSession(s.sessionType, s.structure))
      .map((s) => s.date)
      .sort();
    expect(hardDates).toEqual(["2026-01-05", "2026-01-08"]);
  });

  it("is a no-op when hard sessions are already spaced", () => {
    const week = [sess("2026-01-05", "TEMPO", true), sess("2026-01-08", "LONG_INTERVALS", true)];
    expect(spaceHardSessions(week).map((s) => s.date)).toEqual(["2026-01-05", "2026-01-08"]);
  });

  it("best-effort no-op when nothing swappable", () => {
    const week = [sess("2026-01-05", "TEMPO", true), sess("2026-01-06", "LONG_INTERVALS", true)];
    expect(spaceHardSessions(week)).toHaveLength(2);
  });
});

describe("resolveDaysPerWeek", () => {
  it("honours an explicit request", () => {
    expect(resolveDaysPerWeek(6, 3.2)).toBe(6);
  });

  it("infers from observed average when absent", () => {
    expect(resolveDaysPerWeek(null, 4.4)).toBe(4);
  });

  it("falls back to the default with no history", () => {
    expect(resolveDaysPerWeek(null, null)).toBe(DEFAULT_DAYS_PER_WEEK);
    expect(resolveDaysPerWeek(undefined, 0)).toBe(DEFAULT_DAYS_PER_WEEK);
  });

  it("clamps to 1–7", () => {
    expect(resolveDaysPerWeek(9, null)).toBe(7);
    expect(resolveDaysPerWeek(0, null)).toBe(1);
  });
});

describe("longRunOffset / placeLongRun", () => {
  it("defaults to Sunday (offset 6) and clamps", () => {
    expect(longRunOffset(undefined)).toBe(6);
    expect(longRunOffset(0)).toBe(0);
    expect(longRunOffset(9)).toBe(6);
    expect(longRunOffset(-1)).toBe(0);
  });

  it("moves the long-bucket session onto the preferred day (Monday-aligned week)", () => {
    const week = [
      sess("2026-01-06", "LONG"),
      sess("2026-01-07", "EASY"),
    ];
    const out = placeLongRun(week, "2026-01-05", 6); // Sunday of that week
    expect(out.find((s) => s.sessionType === "LONG")?.date).toBe("2026-01-11");
  });

  it("also relocates a PROGRESSIVE_LONG and no-ops without a long run", () => {
    const withProg = placeLongRun([sess("2026-01-06", "PROGRESSIVE_LONG")], "2026-01-05", 0);
    expect(withProg[0].date).toBe("2026-01-05");
    const noLong = placeLongRun([sess("2026-01-06", "EASY")], "2026-01-05", 6);
    expect(noLong[0].date).toBe("2026-01-06");
  });
});

describe("enforceDaysPerWeek", () => {
  it("trims the latest easy fill runs first, protecting hard + long", () => {
    const week = [
      sess("2026-01-05", "LONG_INTERVALS", true),
      sess("2026-01-06", "LONG"),
      sess("2026-01-07", "EASY"),
      sess("2026-01-08", "EASY"),
      sess("2026-01-09", "EASY"),
      sess("2026-01-10", "EASY"),
    ];
    const out = enforceDaysPerWeek(week, 4);
    expect(out).toHaveLength(4);
    expect(hardCount(out)).toBe(1);
    expect(out.some((s) => s.sessionType === "LONG")).toBe(true);
    expect(out.map((s) => s.date)).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
    ]);
  });

  it("no-ops when already at or under the cap", () => {
    const week = [sess("2026-01-05", "EASY"), sess("2026-01-07", "TEMPO", true)];
    expect(enforceDaysPerWeek(week, 5)).toHaveLength(2);
  });

  it("drops protected sessions only when nothing else remains to trim", () => {
    const week = [
      sess("2026-01-05", "TEMPO", true),
      sess("2026-01-07", "LONG_INTERVALS", true),
      sess("2026-01-09", "SHORT_INTERVALS", true),
    ];
    expect(enforceDaysPerWeek(week, 2)).toHaveLength(2);
  });
});

describe("substituteCrossTraining", () => {
  const injuryWeek = () => [
    sess("2026-01-05", "LONG_INTERVALS", true),
    sess("2026-01-06", "LONG"),
    sess("2026-01-08", "EASY"),
    sess("2026-01-10", "RECOVERY"),
  ];

  it("converts up to count easy/recovery runs to OTHER cross-training", () => {
    const out = substituteCrossTraining(injuryWeek(), 2);
    const cross = out.filter((s) => s.sessionType === "OTHER");
    expect(cross).toHaveLength(2);
    expect(cross.every((s) => s.structure === null && s.title === CROSS_TRAINING_TITLE)).toBe(true);
    expect(out.some((s) => s.sessionType === "LONG")).toBe(true);
    expect(hardCount(out)).toBe(1);
  });

  it("caps substitutions at 2 per week", () => {
    const week = ["2026-01-05", "2026-01-06", "2026-01-08", "2026-01-10"].map((d) => sess(d, "EASY"));
    expect(substituteCrossTraining(week, 5).filter((s) => s.sessionType === "OTHER")).toHaveLength(2);
  });

  it("no-ops with count 0 or fewer than 2 easy runs to spare", () => {
    expect(substituteCrossTraining(injuryWeek(), 0)).toEqual(injuryWeek());
    const oneEasy = [sess("2026-01-05", "LONG"), sess("2026-01-08", "EASY")];
    expect(substituteCrossTraining(oneEasy, 2)).toEqual(oneEasy);
  });
});
