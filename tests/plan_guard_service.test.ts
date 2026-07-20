import { describe, expect, it } from "bun:test";
import {
  enforcePlanWriteInvariants,
  evaluatePlanWeek,
  type PlanGuardContext,
  type PlanGuardSession,
  type PlanGuardWeek,
  weekVolumeMeters,
} from "../src/services/plan_guard_service";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";

const baseCtx: PlanGuardContext = {
  volumeAggressiveness: "steady",
  intensityAggressiveness: "balanced",
  maxWeeklyVolumeMeters: null,
  daysPerWeek: null,
  preferredLongRunDay: null,
  baselineWeeklyMeters: null,
  longestRunMeters: null,
  raceDistanceMeters: null,
  activeInjuries: [],
};

const baseWeek: PlanGuardWeek = {
  weekIndex: 2,
  ordinal: 1,
  phase: null,
  peakPrecedingWeekDistanceMeters: null,
};

/** A structureless session carrying the plan-builder's `~X.X km` volume hint. */
function easy(date: string, km: number): PlanGuardSession {
  return {
    date,
    sessionType: "EASY",
    title: "Easy run",
    description: `~${km.toFixed(1)} km`,
    structure: null,
  };
}

function intervals(date: string): PlanGuardSession {
  const structure: WorkoutStructureSet[] = [
    {
      set_reps: 5,
      set_recovery: 90,
      steps: [
        {
          reps: 1,
          work_type: "DISTANCE",
          work_value: 1000,
          recovery_type: "TIME",
          recovery_value: 60,
          target_pace: null,
        },
      ],
    },
  ];
  return {
    date,
    sessionType: "LONG_INTERVALS",
    title: "5x1000m",
    description: null,
    structure,
  };
}

describe("enforcePlanWriteInvariants", () => {
  it("nulls every target pace on a written structure", () => {
    const structure = [
      {
        set_reps: 1,
        set_recovery: 0,
        steps: [
          {
            reps: 3,
            work_type: "DISTANCE" as const,
            work_value: 1000,
            recovery_type: "TIME" as const,
            recovery_value: 60,
            target_pace: 240,
            target_paces: [235, 245],
          },
        ],
      },
    ];

    const out = enforcePlanWriteInvariants(structure);
    expect(out?.[0].steps[0].target_pace).toBeNull();
    expect(out?.[0].steps[0].target_paces).toBeNull();
    expect(out?.[0].steps[0].work_value).toBe(1000);
  });

  it("maps null to null", () => {
    expect(enforcePlanWriteInvariants(null)).toBeNull();
  });

  it("preserves undefined so a PATCH leaves the stored structure alone", () => {
    expect(enforcePlanWriteInvariants(undefined)).toBeUndefined();
  });
});

describe("weekVolumeMeters", () => {
  it("sums structure estimates and ~X km description hints", () => {
    expect(weekVolumeMeters([easy("2026-01-05", 10)])).toBe(10_000);
  });

  it("is zero for a week with no sessions", () => {
    expect(weekVolumeMeters([])).toBe(0);
  });
});

describe("evaluatePlanWeek — weekly_ramp_exceeded", () => {
  it("warns when the week outgrows the steady ramp ceiling", () => {
    const warnings = evaluatePlanWeek(
      baseCtx,
      { ...baseWeek, peakPrecedingWeekDistanceMeters: 40_000 },
      [easy("2026-01-05", 60)],
    );
    const ramp = warnings.find((w) => w.code === "weekly_ramp_exceeded");
    expect(ramp).toBeDefined();
    expect(ramp?.observed).toBe(60_000);
    expect(ramp?.limit).toBe(44_000);
    expect(ramp?.weekIndex).toBe(2);
  });

  it("stays silent inside the ceiling", () => {
    const warnings = evaluatePlanWeek(
      baseCtx,
      { ...baseWeek, peakPrecedingWeekDistanceMeters: 40_000 },
      [easy("2026-01-05", 43)],
    );
    expect(warnings).toEqual([]);
  });

  it("lets a recovery week through", () => {
    const warnings = evaluatePlanWeek(
      baseCtx,
      { ...baseWeek, peakPrecedingWeekDistanceMeters: 40_000 },
      [easy("2026-01-05", 30)],
    );
    expect(warnings).toEqual([]);
  });

  // The write guard used to be prev-relative while the builder's final invariant
  // is peak-relative, so every 4-week-cadence plan the builder produced tripped
  // its own warning on the week after each down week — editing anything in a
  // rebuild week warned the athlete about a shape we generated.
  it("does not warn on the rebuild week after a down week", () => {
    const warnings = evaluatePlanWeek(
      baseCtx,
      { ...baseWeek, weekIndex: 5, ordinal: 4, peakPrecedingWeekDistanceMeters: 48_400 },
      [easy("2026-02-02", 53.2)], // rebuild off a 34.8 km down week, under the prior peak + 10%
    );
    expect(warnings).toEqual([]);
  });

  it("still warns when the week outgrows the highest week before it", () => {
    const warnings = evaluatePlanWeek(
      baseCtx,
      { ...baseWeek, weekIndex: 5, ordinal: 4, peakPrecedingWeekDistanceMeters: 48_400 },
      [easy("2026-02-02", 70)],
    );
    expect(warnings.find((w) => w.code === "weekly_ramp_exceeded")).toBeDefined();
  });

  it("agrees with the shape the plan builder itself produces", async () => {
    const { shapeMacro } = await import("../src/agent/planning/guards");
    const weeks = Array.from({ length: 8 }, (_, i) => ({
      weekIndex: i + 1,
      startDate: "2026-01-05",
      phase: "build" as const,
      targetDistanceMeters: 60_000,
      notes: null,
      keySessions: [],
    }));
    const { macro } = shapeMacro(
      { name: "n", rationale: "r", weeks },
      { startDate: "2026-01-05", endDate: "2026-03-01", raceEventId: null } as never,
      {
        baselineWeeklyMeters: 40_000,
        longestRunMeters: null,
        volumeAggressiveness: "steady",
        maxWeeklyVolumeMeters: null,
        raceDistanceMeters: null,
      },
    );

    let peak: number | null = null;
    for (const [i, w] of macro.weeks.entries()) {
      const meters = w.targetDistanceMeters;
      const warnings = evaluatePlanWeek(
        baseCtx,
        {
          weekIndex: w.weekIndex,
          ordinal: i,
          phase: w.phase,
          peakPrecedingWeekDistanceMeters: peak,
        },
        [easy(w.startDate, meters / 1000)],
      );
      expect({
        week: w.weekIndex,
        ramp: warnings.filter((x) => x.code === "weekly_ramp_exceeded").length,
      }).toEqual({ week: w.weekIndex, ramp: 0 });
      peak = Math.max(peak ?? 0, meters);
    }
  });

  it("allows a bigger jump at progressive than at gradual", () => {
    const week = { ...baseWeek, peakPrecedingWeekDistanceMeters: 40_000 };
    const sessions = [easy("2026-01-05", 48)];
    expect(
      evaluatePlanWeek({ ...baseCtx, volumeAggressiveness: "progressive" }, week, sessions),
    ).toEqual([]);
    expect(
      evaluatePlanWeek({ ...baseCtx, volumeAggressiveness: "gradual" }, week, sessions).map(
        (w) => w.code,
      ),
    ).toEqual(["weekly_ramp_exceeded"]);
  });

  it("skips the check without a previous week to ramp from", () => {
    expect(evaluatePlanWeek(baseCtx, baseWeek, [easy("2026-01-05", 90)])).toEqual([]);
  });
});

describe("evaluatePlanWeek — long_run_spike", () => {
  const ctx = { ...baseCtx, longestRunMeters: 15_000 };

  it("warns when the week's implied long run spikes past the ceiling", () => {
    const warnings = evaluatePlanWeek(ctx, { ...baseWeek, ordinal: 0 }, [easy("2026-01-05", 80)]);
    const spike = warnings.find((w) => w.code === "long_run_spike");
    expect(spike).toBeDefined();
    // ceiling at ordinal 0 = 15000 * 1.3 = 19_500
    expect(spike?.limit).toBe(19_500);
    expect(spike?.observed).toBe(28_000);
  });

  it("lets the ceiling grow with the week's ordinal", () => {
    const sessions = [easy("2026-01-05", 57)];
    // implied long = 19_950; over the ordinal-0 ceiling, under ordinal 2's (~23_595)
    expect(
      evaluatePlanWeek(ctx, { ...baseWeek, ordinal: 0 }, sessions).map((w) => w.code),
    ).toEqual(["long_run_spike"]);
    expect(evaluatePlanWeek(ctx, { ...baseWeek, ordinal: 2 }, sessions)).toEqual([]);
  });

  it("is a no-op without a known recent longest run", () => {
    expect(evaluatePlanWeek(baseCtx, baseWeek, [easy("2026-01-05", 200)])).toEqual([]);
  });
});

describe("evaluatePlanWeek — quality_sessions_exceeded", () => {
  it("warns when a base week carries quality work", () => {
    const warnings = evaluatePlanWeek(baseCtx, { ...baseWeek, phase: "base" }, [
      intervals("2026-01-06"),
      easy("2026-01-07", 8),
    ]);
    expect(warnings.map((w) => w.code)).toEqual(["quality_sessions_exceeded"]);
    expect(warnings[0].observed).toBe(1);
    expect(warnings[0].limit).toBe(0);
  });

  it("allows two quality sessions in a balanced build week", () => {
    const warnings = evaluatePlanWeek(baseCtx, { ...baseWeek, phase: "build" }, [
      intervals("2026-01-06"),
      intervals("2026-01-08"),
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns on the third quality session of a balanced build week", () => {
    const warnings = evaluatePlanWeek(baseCtx, { ...baseWeek, phase: "build" }, [
      intervals("2026-01-06"),
      intervals("2026-01-08"),
      intervals("2026-01-10"),
    ]);
    expect(warnings.map((w) => w.code)).toEqual(["quality_sessions_exceeded"]);
    expect(warnings[0].limit).toBe(2);
  });

  it("shifts the cap with the intensity dial", () => {
    const sessions = [intervals("2026-01-06"), intervals("2026-01-08"), intervals("2026-01-10")];
    const week = { ...baseWeek, phase: "build" as const };
    expect(
      evaluatePlanWeek({ ...baseCtx, intensityAggressiveness: "challenging" }, week, sessions),
    ).toEqual([]);
    expect(
      evaluatePlanWeek({ ...baseCtx, intensityAggressiveness: "comfortable" }, week, sessions)[0]
        .limit,
    ).toBe(1);
  });

  it("skips the check when the week has no phase", () => {
    const warnings = evaluatePlanWeek(baseCtx, baseWeek, [
      intervals("2026-01-06"),
      intervals("2026-01-08"),
      intervals("2026-01-10"),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("evaluatePlanWeek — days_per_week_exceeded", () => {
  const sixDays = ["05", "06", "07", "08", "09", "10"].map((d) => easy(`2026-01-${d}`, 8));

  it("warns when the week schedules more sessions than the athlete's run days", () => {
    const warnings = evaluatePlanWeek({ ...baseCtx, daysPerWeek: 4 }, baseWeek, sixDays);
    const days = warnings.find((w) => w.code === "days_per_week_exceeded");
    expect(days?.observed).toBe(6);
    expect(days?.limit).toBe(4);
  });

  it("stays silent at exactly the configured run days", () => {
    expect(evaluatePlanWeek({ ...baseCtx, daysPerWeek: 6 }, baseWeek, sixDays)).toEqual([]);
  });

  it("skips the check when the plan stores no explicit day count", () => {
    expect(evaluatePlanWeek(baseCtx, baseWeek, sixDays)).toEqual([]);
  });
});

describe("evaluatePlanWeek — max_weekly_volume_exceeded", () => {
  it("warns above the athlete's hard weekly ceiling", () => {
    const warnings = evaluatePlanWeek({ ...baseCtx, maxWeeklyVolumeMeters: 50_000 }, baseWeek, [
      easy("2026-01-05", 65),
    ]);
    const cap = warnings.find((w) => w.code === "max_weekly_volume_exceeded");
    expect(cap?.observed).toBe(65_000);
    expect(cap?.limit).toBe(50_000);
  });

  it("stays silent at the ceiling", () => {
    expect(
      evaluatePlanWeek({ ...baseCtx, maxWeeklyVolumeMeters: 50_000 }, baseWeek, [
        easy("2026-01-05", 50),
      ]),
    ).toEqual([]);
  });
});

describe("evaluatePlanWeek — composition", () => {
  it("reports every independent violation for one week", () => {
    const ctx: PlanGuardContext = {
      ...baseCtx,
      longestRunMeters: 10_000,
      maxWeeklyVolumeMeters: 40_000,
      daysPerWeek: 3,
    };
    const sessions = [
      intervals("2026-01-05"),
      intervals("2026-01-07"),
      intervals("2026-01-09"),
      easy("2026-01-10", 60),
    ];
    const codes = evaluatePlanWeek(
      ctx,
      { ...baseWeek, ordinal: 0, phase: "base", peakPrecedingWeekDistanceMeters: 30_000 },
      sessions,
    ).map((w) => w.code);

    expect(codes).toContain("weekly_ramp_exceeded");
    expect(codes).toContain("long_run_spike");
    expect(codes).toContain("quality_sessions_exceeded");
    expect(codes).toContain("days_per_week_exceeded");
    expect(codes).toContain("max_weekly_volume_exceeded");
  });

  it("returns no warnings for a sane week", () => {
    const ctx: PlanGuardContext = {
      ...baseCtx,
      longestRunMeters: 18_000,
      maxWeeklyVolumeMeters: 60_000,
      daysPerWeek: 5,
    };
    const sessions = [
      easy("2026-01-05", 8),
      intervals("2026-01-07"),
      easy("2026-01-08", 8),
      easy("2026-01-10", 18),
    ];
    expect(
      evaluatePlanWeek(
        ctx,
        { ...baseWeek, ordinal: 1, phase: "build", peakPrecedingWeekDistanceMeters: 42_000 },
        sessions,
      ),
    ).toEqual([]);
  });
});
