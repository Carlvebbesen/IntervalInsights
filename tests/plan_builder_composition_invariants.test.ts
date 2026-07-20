import { describe, expect, it } from "bun:test";
import {
  assembleWeekSessions,
  assertPlanHasSessions,
  estimateStructureDistanceMeters,
  IMPLIED_LONG_RUN_FRACTION,
  isHardSession,
  LONG_RUN_SPIKE_CAP,
  LONG_RUN_WEEKLY_GROWTH,
  longRunOffset,
  qualityCap,
  repairMacro,
  type SessionGuardParams,
  VOLUME_RAMP,
} from "../src/agent/planning/guards";
import type {
  GeneratedSession,
  PlanMacro,
  PlanMacroWeek,
} from "../src/agent/planning/plan_builder_schemas";
import {
  INTENSITY_AGGRESSIVENESS,
  type PlanBuilderInput,
  VOLUME_AGGRESSIVENESS,
} from "../src/agent/planning/plan_builder_state";
import { planWeekPhaseEnum, trainingTypeEnum } from "../src/schema/enums";

// Every existing guard test drives ONE guard with a hand-written, well-formed
// fixture — which makes the guards effectively no-ops and let two composition
// bugs survive 62 of them. These tests assert properties of the COMPOSED output
// under adversarial input: whatever the LLM returned, these must hold.

// Deterministic PRNG (mulberry32) so a failing case is reproducible from its seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

// ── repairMacro ──────────────────────────────────────────────────────────────

/** Absurd weekly volumes: negative, zero, missing, and marathon-a-week nonsense. */
function adversarialTargets(r: () => number, n: number): number[] {
  return Array.from({ length: n }, () =>
    pick(r, [0, 0, -5000, 1, 250_000, 900_000, int(r, 0, 400_000), Number.NaN]),
  );
}

function adversarialMacro(r: () => number, n: number): PlanMacro {
  return {
    name: "adversarial",
    rationale: "r",
    weeks: adversarialTargets(r, n).map((targetDistanceMeters, i) => ({
      // Week index/startDate are deliberately garbage — repairMacro rebuilds them.
      weekIndex: pick(r, [i + 1, 0, 99, -3]),
      startDate: pick(r, ["not-a-date", "2020-01-01", ""]),
      phase: pick(r, planWeekPhaseEnum.enumValues),
      targetDistanceMeters,
      notes: null,
      keySessions: [],
    })),
  };
}

/** endDate covering `n` Monday-aligned weeks from a fixed Monday start. */
function inputForWeeks(n: number, over: Partial<PlanBuilderInput> = {}): PlanBuilderInput {
  const start = new Date(Date.UTC(2026, 0, 5)); // Monday
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (n - 1) * 7);
  return {
    startDate: "2026-01-05",
    endDate: end.toISOString().slice(0, 10),
    ...over,
  };
}

describe("repairMacro composition invariants (adversarial macros)", () => {
  const cases = SEEDS.map((seed) => {
    const r = rng(seed);
    const weeks = int(r, 1, 20);
    const volumeAggressiveness = pick(r, VOLUME_AGGRESSIVENESS);
    const raceAnchored = r() < 0.5;
    const raceDistanceMeters = raceAnchored ? pick(r, [5000, 10_000, 21_097, 42_195]) : null;
    const input = inputForWeeks(weeks, raceAnchored ? { raceEventId: 7 } : {});
    const params = {
      baselineWeeklyMeters: pick(r, [null, 0, -1, 1, 20_000, 45_000, 300_000]),
      longestRunMeters: pick(r, [null, 0, 3_000, 12_000, 500_000]),
      volumeAggressiveness,
      maxWeeklyVolumeMeters: pick(r, [null, 25_000, 60_000]),
      raceDistanceMeters,
    };
    return {
      seed,
      params,
      raceAnchored,
      out: repairMacro(adversarialMacro(r, weeks), input, params).weeks,
    };
  });

  it("never ramps a week above the aggressiveness ceiling relative to the running peak", () => {
    for (const { seed, params, out } of cases) {
      const { ceiling, burst } = VOLUME_RAMP[params.volumeAggressiveness];
      const v = out.map((w) => w.targetDistanceMeters);
      let peak = v[0];
      let prevBurst = false;
      for (let i = 1; i < v.length; i++) {
        const allowed = prevBurst ? ceiling : burst;
        expect({ seed, i, value: v[i] }).toEqual({
          seed,
          i,
          value: Math.min(v[i], Math.round(peak * (1 + allowed))),
        });
        prevBurst = v[i] > Math.round(peak * (1 + ceiling));
        peak = Math.max(peak, v[i]);
      }
    }
  });

  it("never produces a zero-volume (or negative, or non-finite) week", () => {
    for (const { seed, out } of cases) {
      for (const w of out) {
        expect({ seed, week: w.weekIndex, ok: Number.isFinite(w.targetDistanceMeters) }).toEqual({
          seed,
          week: w.weekIndex,
          ok: true,
        });
        expect({ seed, week: w.weekIndex, positive: w.targetDistanceMeters > 0 }).toEqual({
          seed,
          week: w.weekIndex,
          positive: true,
        });
      }
    }
  });

  it("holds the long-run spike cap on the FINAL output, not just after its own stage", () => {
    for (const { seed, params, out } of cases) {
      const longest = params.longestRunMeters;
      if (longest == null || longest <= 0) continue;
      out.forEach((w, i) => {
        const allowed =
          longest * (1 + LONG_RUN_SPIKE_CAP) * (1 + LONG_RUN_WEEKLY_GROWTH) ** i +
          // the cap is applied via a rounded volume, so allow 1 m of rounding slack
          IMPLIED_LONG_RUN_FRACTION;
        const implied = w.targetDistanceMeters * IMPLIED_LONG_RUN_FRACTION;
        expect({ seed, i, over: implied > allowed }).toEqual({ seed, i, over: false });
      });
    }
  });

  it("respects the user's hard weekly ceiling everywhere", () => {
    for (const { seed, params, out } of cases) {
      const max = params.maxWeeklyVolumeMeters;
      if (max == null) continue;
      for (const w of out) {
        expect({ seed, over: w.targetDistanceMeters > max }).toEqual({ seed, over: false });
      }
    }
  });

  it("keeps taper weeks strictly decreasing into the race", () => {
    for (const { seed, raceAnchored, out } of cases) {
      if (!raceAnchored) continue;
      const taper = out.filter((w) => w.phase === "taper" || w.phase === "race");
      for (let i = 1; i < taper.length; i++) {
        expect({
          seed,
          i,
          decreasing: taper[i].targetDistanceMeters < taper[i - 1].targetDistanceMeters,
        }).toEqual({ seed, i, decreasing: true });
      }
    }
  });

  it("always rebuilds a contiguous Monday-aligned week grid", () => {
    for (const { seed, out } of cases) {
      out.forEach((w, i) => {
        expect({ seed, i, weekIndex: w.weekIndex }).toEqual({ seed, i, weekIndex: i + 1 });
        expect({ seed, i, dow: new Date(`${w.startDate}T00:00:00Z`).getUTCDay() }).toEqual({
          seed,
          i,
          dow: 1,
        });
      });
    }
  });
});

// ── assembleWeekSessions ─────────────────────────────────────────────────────

const ALL_TYPES = trainingTypeEnum.enumValues;

/** Malformed LLM week output: bad dates, wrong week, absurd counts, paced structures. */
function adversarialSessions(r: () => number, weekStart: string): GeneratedSession[] {
  const n = int(r, 0, 15);
  return Array.from({ length: n }, () => {
    const structured = r() < 0.5;
    return {
      date: pick(r, [
        weekStart,
        "2026-01-08",
        "1999-12-31",
        "2099-06-01",
        "not-a-date",
        "",
        `2026-01-${String(int(r, 1, 28)).padStart(2, "0")}`,
      ]),
      sessionType: pick(r, ALL_TYPES),
      title: "t",
      description: pick(r, [null, "desc"]),
      structure: structured
        ? [
            {
              set_reps: int(r, 1, 4),
              steps: [
                {
                  reps: int(r, 1, 8),
                  work_type: pick(r, ["TIME", "DISTANCE"] as const),
                  work_value: int(r, 60, 5000),
                  // The LLM is forbidden from emitting paces; assert stripPaces holds.
                  target_pace: 3.5,
                  target_paces: { min: 3.0, max: 4.0 },
                },
              ],
            },
          ]
        : pick(r, [null, []]),
    } as GeneratedSession;
  });
}

const daysApart = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;

describe("assembleWeekSessions composition invariants (adversarial LLM weeks)", () => {
  const cases = SEEDS.map((seed) => {
    const r = rng(seed);
    const week: PlanMacroWeek = {
      weekIndex: 1,
      startDate: "2026-01-05", // Monday; week is 2026-01-05..2026-01-11
      phase: pick(r, planWeekPhaseEnum.enumValues),
      targetDistanceMeters: pick(r, [0, 1, 40_000, 250_000]),
      notes: null,
      keySessions: [],
    };
    const params: SessionGuardParams = {
      intensityAggressiveness: pick(r, INTENSITY_AGGRESSIVENESS),
      daysPerWeek: int(r, 1, 7),
      preferredLongRunDay: pick(r, [null, 0, 3, 6]),
      crossTrainingCount: int(r, 0, 3),
    };
    const raw = adversarialSessions(r, week.startDate);
    return { seed, week, params, raw, out: assembleWeekSessions(week, raw, params) };
  });

  it("never schedules more sessions than the athlete's run-day count", () => {
    for (const { seed, params, out } of cases) {
      expect({ seed, over: out.length > params.daysPerWeek }).toEqual({ seed, over: false });
    }
  });

  it("never places two hard days back-to-back", () => {
    for (const { seed, out } of cases) {
      const hard = out.filter((s) => isHardSession(s.sessionType, s.structure));
      for (let i = 1; i < hard.length; i++) {
        expect({ seed, i, gap: daysApart(hard[i - 1].date, hard[i].date) > 1 }).toEqual({
          seed,
          i,
          gap: true,
        });
      }
    }
  });

  it("never exceeds the phase/intensity quality cap", () => {
    for (const { seed, week, params, out } of cases) {
      const hard = out.filter((s) => isHardSession(s.sessionType, s.structure)).length;
      const cap = qualityCap(week.phase, params.intensityAggressiveness);
      expect({ seed, over: hard > cap }).toEqual({ seed, over: false });
    }
  });

  it("keeps every session inside its own Monday–Sunday week, as a valid date", () => {
    for (const { seed, week, out } of cases) {
      for (const s of out) {
        expect({ seed, date: s.date, valid: /^\d{4}-\d{2}-\d{2}$/.test(s.date) }).toEqual({
          seed,
          date: s.date,
          valid: true,
        });
        const offset = daysApart(week.startDate, s.date);
        expect({ seed, date: s.date, inWeek: s.date >= week.startDate && offset <= 6 }).toEqual({
          seed,
          date: s.date,
          inWeek: true,
        });
      }
    }
  });

  it("strips every target pace no matter what the LLM emitted", () => {
    for (const { seed, out } of cases) {
      for (const s of out) {
        for (const set of s.structure ?? []) {
          for (const step of set.steps) {
            expect({ seed, pace: step.target_pace, paces: step.target_paces }).toEqual({
              seed,
              pace: null,
              paces: null,
            });
          }
        }
      }
    }
  });

  // This assertion used to `continue` when zero long runs survived — which made
  // it vacuous on exactly the weeks where the guards had destroyed the long run,
  // the bug it was written to catch. The long run is the week's anchor and the
  // LAST thing the guards may sacrifice, so survival is the assertion.
  const isLong = (s: GeneratedSession) =>
    s.sessionType === "LONG" || s.sessionType === "PROGRESSIVE_LONG";
  const preferredDay = (week: PlanMacroWeek, params: SessionGuardParams) => {
    const d = new Date(`${week.startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + longRunOffset(params.preferredLongRunDay));
    return d.toISOString().slice(0, 10);
  };

  it("never destroys a long run the LLM asked for, and pins it to the preferred day", () => {
    for (const { seed, week, params, raw, out } of cases) {
      // Precondition on the INPUT only (never the outcome): the week asked for a
      // long run, and no session was lost to the 7-per-week truncation.
      if (raw.length > 7 || !raw.some(isLong)) continue;
      const longs = out.filter(isLong);
      expect({ seed, survived: longs.length > 0 }).toEqual({ seed, survived: true });
      expect({ seed, pinned: longs.some((s) => s.date === preferredDay(week, params)) }).toEqual({
        seed,
        pinned: true,
      });
    }
  });

  // Fixed-shape cases: exactly one long run in an otherwise adversarial week, so
  // survival is unconditional rather than dependent on what the PRNG emitted.
  it("keeps the week's long run under every day-count / intensity / phase combination", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const week: PlanMacroWeek = {
        weekIndex: 1,
        startDate: "2026-01-05",
        phase: pick(r, planWeekPhaseEnum.enumValues),
        targetDistanceMeters: 45_000,
        notes: null,
        keySessions: [],
      };
      const params: SessionGuardParams = {
        intensityAggressiveness: pick(r, INTENSITY_AGGRESSIVENESS),
        daysPerWeek: int(r, 1, 7),
        preferredLongRunDay: pick(r, [null, 0, 3, 6]),
        crossTrainingCount: int(r, 0, 3),
      };
      const hardType = pick(r, ["TEMPO", "LONG_INTERVALS", "HILL_SPRINTS"] as const);
      const raw: GeneratedSession[] = [
        { date: "2026-01-05", sessionType: "EASY", title: "e", description: null, structure: null },
        { date: "2026-01-07", sessionType: "EASY", title: "e", description: null, structure: null },
        { date: "2026-01-09", sessionType: "EASY", title: "e", description: null, structure: null },
        {
          date: "2026-01-10",
          sessionType: hardType,
          title: "q",
          description: null,
          structure: null,
        },
        {
          date: pick(r, ["2026-01-07", "2026-01-09", "2026-01-11"]),
          sessionType: pick(r, ["LONG", "PROGRESSIVE_LONG"] as const),
          title: "l",
          description: null,
          structure: null,
        },
      ] as GeneratedSession[];
      const out = assembleWeekSessions(week, raw, params);
      const longs = out.filter(isLong);
      expect({ seed, survived: longs.length > 0 }).toEqual({ seed, survived: true });
      expect({ seed, pinned: longs.some((s) => s.date === preferredDay(week, params)) }).toEqual({
        seed,
        pinned: true,
      });
    }
  });

  // The layout this product exists to serve: Saturday club/group session plus a
  // Sunday long run. Guards must resolve the adjacency by moving the SATURDAY
  // session, never by eating the long run.
  it("keeps both the Saturday group session and the Sunday long run (club-runner week)", () => {
    const week: PlanMacroWeek = {
      weekIndex: 1,
      startDate: "2026-01-05",
      phase: "build",
      targetDistanceMeters: 50_000,
      notes: null,
      keySessions: [],
    };
    const structure = [
      {
        set_reps: 1,
        steps: [
          {
            reps: 1,
            work_type: "TIME" as const,
            work_value: 1200,
            target_pace: null,
            target_paces: null,
          },
        ],
      },
    ];
    const raw = [
      { date: "2026-01-05", sessionType: "EASY", title: "e", description: null, structure: null },
      { date: "2026-01-06", sessionType: "EASY", title: "e", description: null, structure: null },
      { date: "2026-01-07", sessionType: "PROGRESSIVE_LONG", title: "l", description: null, structure },
      { date: "2026-01-08", sessionType: "EASY", title: "e", description: null, structure: null },
      { date: "2026-01-09", sessionType: "EASY", title: "e", description: null, structure: null },
      { date: "2026-01-10", sessionType: "TEMPO", title: "t", description: null, structure },
    ] as GeneratedSession[];

    const out = assembleWeekSessions(week, raw, {
      intensityAggressiveness: "balanced",
      daysPerWeek: 6,
      preferredLongRunDay: 6, // Sunday
      crossTrainingCount: 0,
    });

    const long = out.find(isLong);
    expect(long?.sessionType).toBe("PROGRESSIVE_LONG");
    expect(long?.date).toBe("2026-01-11"); // Sunday, the preferred day
    // The tempo survives too — it moved off Saturday rather than being downgraded.
    const tempo = out.find((s) => s.sessionType === "TEMPO");
    expect(tempo).toBeDefined();
    expect(daysApart(tempo?.date ?? "", "2026-01-11") > 1).toBe(true);
  });

  it("never invents sessions the LLM did not return", () => {
    for (const { seed, raw, out } of cases) {
      expect({ seed, over: out.length > raw.length }).toEqual({ seed, over: false });
    }
  });

  it("distributes the week's volume budget only across structureless fill runs", () => {
    for (const { seed, week, out } of cases) {
      const structured = out.reduce((n, s) => n + estimateStructureDistanceMeters(s.structure), 0);
      const fill = out.filter((s) => !s.structure || s.structure.length === 0);
      if (fill.length === 0 || week.targetDistanceMeters <= structured) continue;
      for (const s of fill) {
        expect({ seed, hinted: /~[\d.]+ km/.test(s.description ?? "") }).toEqual({
          seed,
          hinted: true,
        });
      }
    }
  });
});

// ── the plan-level post-condition ────────────────────────────────────────────

describe("assertPlanHasSessions", () => {
  const weeks = [{ weekIndex: 1 }, { weekIndex: 2 }, { weekIndex: 3 }];
  const full = weeks.map((w) => ({ weekIndex: w.weekIndex, sessions: [{}, {}] }));

  it("passes a plan with sessions in every week", () => {
    expect(() => assertPlanHasSessions(weeks, full)).not.toThrow();
  });

  it("rejects a plan where the LLM returned nothing at all", () => {
    expect(() => assertPlanHasSessions(weeks, [])).toThrow(/no sessions for week\(s\) 1, 2, 3/);
  });

  it("rejects a plan with a single empty week", () => {
    const holed = full.map((w) => (w.weekIndex === 2 ? { ...w, sessions: [] } : w));
    expect(() => assertPlanHasSessions(weeks, holed)).toThrow(/no sessions for week\(s\) 2/);
  });
});
