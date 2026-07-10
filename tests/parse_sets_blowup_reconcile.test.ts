import { describe, expect, it } from "bun:test";
import { reconcileSetsBlowup, workoutSet } from "../src/agent/initial_analysis_agent";
import type { z } from "zod";

// Sets-level guardrail applied to parse-agent output (D4): collapse the Cartesian
// rep-count blowup where the model emits N steps that EACH carry reps:N. Same core
// as reconcileStructureBlowup, but operating on a bare workoutSet[] so the parse
// endpoint, the coach parse_workout tool, and the text gate all get scrubbed output.
type Set = z.infer<typeof workoutSet>;
const blowup = (values: number[], work_type: "DISTANCE" | "TIME" = "DISTANCE"): Set[] => [
  {
    set_reps: 1,
    steps: values.map((v) => ({ reps: values.length, work_type, work_value: v })),
  },
];
const totalReps = (sets: Set[]): number =>
  sets.reduce(
    (n, s) => n + (s.set_reps ?? 1) * s.steps.reduce((a, st) => a + (st.reps ?? 1), 0),
    0,
  );

describe("reconcileSetsBlowup", () => {
  it("collapses N (>=3) identical-reps steps to one step at the MEDIAN work_value", () => {
    const out = reconcileSetsBlowup(blowup([936, 906, 693, 954, 991, 959, 988, 1065, 1221]));
    expect(totalReps(out)).toBe(9);
    expect(out[0].steps).toHaveLength(1);
    expect(out[0].steps[0].reps).toBe(9);
    // median ~959m (>=800 keeps LONG); the 693m min must not win.
    expect(out[0].steps[0].work_value).toBeGreaterThanOrEqual(800);
  });
  it("leaves a genuine sequence (steps with reps:1) untouched", () => {
    const seq: Set[] = [
      {
        set_reps: 3,
        steps: [
          { reps: 1, work_type: "DISTANCE", work_value: 3000 },
          { reps: 1, work_type: "DISTANCE", work_value: 2000 },
          { reps: 1, work_type: "DISTANCE", work_value: 1000 },
        ],
      },
    ];
    expect(reconcileSetsBlowup(seq)).toEqual(seq);
  });
  it("passes empty sets through unchanged", () => {
    const empty: Set[] = [];
    const out = reconcileSetsBlowup(empty);
    expect(out).toEqual([]);
    expect(out).toBe(empty);
  });
});
