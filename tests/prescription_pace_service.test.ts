// REAL unit tests for the unified prescription pace pipeline
// (src/services/prescription_pace_service.ts).
//
// PURE UNIT — no database. The two DB-backed stages (history lookup, pace
// anchor) are injected through `computeAdjustedPace`'s `deps` seam, so this file
// exercises the ORCHESTRATION (stage order, per-stage skip conditions, failure
// degradation) while the pace math itself stays the real implementation.
//
// Like tests/pace_service.test.ts this must run under the dedicated preload
// (tests/setup.pace.ts, via `bun run test:pace`), because the default preload
// stubs applyReadinessAdjustment into a no-op passthrough. Under the default
// `bun run test` suite the stub is detected and every block is skipped.

import { describe, expect, it } from "bun:test";
import type z from "zod";
import type { workoutSet } from "../src/agent/initial_analysis_agent";
import type { PaceSet } from "../src/services/pace_anchor_service";
import { applyReadinessAdjustment, type ReadinessSignals } from "../src/services/pace_service";
import {
  computeAdjustedPace,
  type PrescriptionPaceDeps,
  toWeatherInput,
} from "../src/services/prescription_pace_service";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";

type WorkoutSet = z.infer<typeof workoutSet>;
type Db = Parameters<typeof computeAdjustedPace>[0];

const REAL = !applyReadinessAdjustment.toString().includes("penaltySecPerKm: 0");
const suite = REAL ? describe : describe.skip;

if (!REAL) {
  describe.skip(
    "prescription_pace_service.test.ts (skipped: pace_service is mocked — run `bun run test:pace`)",
    () => {
      it.skip("see scripts/test-pace.sh + tests/bunfig.pace.toml", () => {});
    },
  );
}

const db = {} as Db;
const USER = "user-1";

// 4x400m — one set, four reps of a rep-distance step.
const SETS: WorkoutSet[] = [
  {
    set_reps: 1,
    set_recovery: null,
    steps: [
      {
        reps: 4,
        work_type: "DISTANCE",
        work_value: 400,
        recovery_type: "TIME",
        recovery_value: 90,
      },
    ],
  } as WorkoutSet,
];

const ANCHOR_PACES: PaceSet = {
  easySecPerKm: 300,
  thresholdSecPerKm: 240,
  intervalSecPerKm: 220,
  repSecPerKm: 200,
};

const NO_READINESS: ReadinessSignals = {
  tsb: null,
  ctl: null,
  atl: null,
  ramp: null,
  hrvStatus: null,
  sleepScore: null,
};

/** sleepScore 30 (< SLEEP_VERY_POOR) → a deterministic 8 s/km readiness penalty. */
const POOR_SLEEP: ReadinessSignals = { ...NO_READINESS, sleepScore: 30 };
const READINESS_PENALTY = 8;

/** Dew point well over the 15 °C threshold → a non-zero heat penalty. */
const HOT = { temperatureC: 30, humidity: 80 };

const emptyHistory = () => generateCompleteIntervalSet(SETS);

function deps(over: Partial<PrescriptionPaceDeps> = {}): PrescriptionPaceDeps {
  return {
    history: async () => emptyHistory(),
    anchor: async () => ({ status: "not_linked", data: null }),
    ...over,
  };
}

const okAnchor = async () =>
  ({
    status: "ok" as const,
    data: {
      anchorSource: "vdot" as const,
      confidence: "high" as const,
      criticalSpeedMps: null,
      dPrimeM: null,
      vdot: 50,
      paces: ANCHOR_PACES,
      predictedRaces: [],
    },
  });

const firstPaceSecPerKm = (sets: ExpandedIntervalSet[]): number | null => {
  const mps = sets[0]?.steps[0]?.target_pace;
  return mps == null ? null : 1000 / mps;
};

suite("computeAdjustedPace — anchor stage", () => {
  it("fills history gaps from the anchor", async () => {
    const res = await computeAdjustedPace(db, USER, { sets: SETS, sessionType: null }, deps({ anchor: okAnchor }));
    expect(firstPaceSecPerKm(res.paces)).toBeCloseTo(ANCHOR_PACES.repSecPerKm as number, 6);
  });

  it("is a no-op when the anchor is not_linked — not an error", async () => {
    const res = await computeAdjustedPace(db, USER, { sets: SETS, sessionType: null }, deps());
    expect(firstPaceSecPerKm(res.paces)).toBeNull();
    expect(res.penaltySecPerKm).toBe(0);
    expect(res.advisory).toBe("");
  });

  it("degrades when the anchor lookup throws rather than failing the call", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null },
      deps({ anchor: async () => { throw new Error("anchor down"); } }),
    );
    expect(firstPaceSecPerKm(res.paces)).toBeNull();
  });

  it("leaves an already-paced step untouched", async () => {
    const withPace = () => {
      const s = emptyHistory();
      s[0].steps[0].target_pace = 1000 / 190;
      return s;
    };
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null },
      deps({ history: async () => withPace(), anchor: okAnchor }),
    );
    expect(firstPaceSecPerKm(res.paces)).toBeCloseTo(190, 6);
  });
});

suite("computeAdjustedPace — stage order", () => {
  it("anchor-fills BEFORE readiness, so a filled pace is eased too", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, readiness: POOR_SLEEP },
      deps({ anchor: okAnchor }),
    );
    // Anchor-then-readiness → 200 + 8. Readiness-then-anchor would leave a bare 200.
    expect(firstPaceSecPerKm(res.paces)).toBeCloseTo(
      (ANCHOR_PACES.repSecPerKm as number) + READINESS_PENALTY,
      6,
    );
    expect(res.penaltySecPerKm).toBe(READINESS_PENALTY);
  });

  it("applies heat after readiness and sums both penalties", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, readiness: POOR_SLEEP, weather: HOT },
      deps({ anchor: okAnchor }),
    );
    const heatPenalty = res.penaltySecPerKm - READINESS_PENALTY;
    expect(heatPenalty).toBeGreaterThan(0);
    expect(firstPaceSecPerKm(res.paces)).toBeCloseTo(
      (ANCHOR_PACES.repSecPerKm as number) + res.penaltySecPerKm,
      6,
    );
  });

  it("composes the readiness and heat advisories in order", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, readiness: POOR_SLEEP, weather: HOT },
      deps({ anchor: okAnchor }),
    );
    expect(res.advisory).toContain("sleep score is very low");
    expect(res.advisory).toContain("dew point");
    expect(res.advisory.indexOf("sleep score")).toBeLessThan(res.advisory.indexOf("dew point"));
  });
});

suite("computeAdjustedPace — skip conditions", () => {
  it("skips readiness entirely when no signals are given", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, weather: HOT },
      deps({ anchor: okAnchor }),
    );
    expect(res.advisory).not.toContain("sleep");
    expect(res.advisory).toContain("dew point");
  });

  it("skips heat entirely when no weather is given", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, readiness: POOR_SLEEP },
      deps({ anchor: okAnchor }),
    );
    expect(res.penaltySecPerKm).toBe(READINESS_PENALTY);
    expect(res.advisory).not.toContain("dew point");
  });

  it("neutral readiness signals produce no penalty and no advisory", async () => {
    const res = await computeAdjustedPace(
      db,
      USER,
      { sets: SETS, sessionType: null, readiness: NO_READINESS },
      deps({ anchor: okAnchor }),
    );
    expect(res.penaltySecPerKm).toBe(0);
    expect(res.advisory).toBe("");
    expect(firstPaceSecPerKm(res.paces)).toBeCloseTo(ANCHOR_PACES.repSecPerKm as number, 6);
  });
});

suite("toWeatherInput", () => {
  it("accepts the coach-chat payload shape", () => {
    expect(toWeatherInput({ temperatureC: 21, humidity: 60, windKph: 9 })).toEqual({
      temperatureC: 21,
      humidity: 60,
      uvIndex: null,
      cloudCover: null,
      apparentTemperatureC: null,
    });
  });

  it("rejects payloads missing temperature or humidity", () => {
    expect(toWeatherInput({ temperatureC: 21 })).toBeUndefined();
    expect(toWeatherInput({ humidity: 60 })).toBeUndefined();
    expect(toWeatherInput(undefined)).toBeUndefined();
    expect(toWeatherInput("warm")).toBeUndefined();
  });
});
