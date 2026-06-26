import { describe, expect, it } from "bun:test";
import { reconcileStructureBlowup } from "../src/agent/initial_analysis_agent";

// Pure guardrail: collapse the Cartesian rep-count blowup where gpt-4o-mini emits
// N steps that EACH carry reps:N (observed: "10x1000m" -> 9 steps x reps 9 = 81),
// inflating the count N->N². Collapse to a single step of reps:R at the median value.
type Out = Parameters<typeof reconcileStructureBlowup>[0];
const mk = (structure: unknown): Out =>
  ({
    classification_reasoning: "x",
    training_type: "LONG_INTERVALS",
    confidence_score: 0.9,
    structure,
  }) as Out;
const blowup = (values: number[], work_type: "DISTANCE" | "TIME" = "DISTANCE") => [
  {
    set_reps: 1,
    steps: values.map((v) => ({ reps: values.length, work_type, work_value: v })),
  },
];
const totalReps = (out: Out): number =>
  (out.structure ?? []).reduce(
    (n, s) => n + (s.set_reps ?? 1) * s.steps.reduce((a, st) => a + (st.reps ?? 1), 0),
    0,
  );

describe("reconcileStructureBlowup", () => {
  it("collapses 9 steps x reps 9 (the 10x1000m N² blowup) to one step reps:9", () => {
    const out = reconcileStructureBlowup(
      mk(blowup([936, 906, 693, 954, 991, 959, 988, 1065, 1221])),
    );
    expect(totalReps(out)).toBe(9);
    expect(out.structure![0].steps).toHaveLength(1);
    expect(out.structure![0].steps[0].reps).toBe(9);
  });
  it("sizes the collapsed step at the MEDIAN so an under-measured rep can't flip the gate", () => {
    // median of the set is ~959m (>=800 keeps LONG); the 693m min must not win.
    const out = reconcileStructureBlowup(
      mk(blowup([936, 906, 693, 954, 991, 959, 988, 1065, 1221])),
    );
    expect(out.structure![0].steps[0].work_value).toBeGreaterThanOrEqual(800);
  });
  it("collapses the 14x14 treadmill blowup to reps:14", () => {
    const out = reconcileStructureBlowup(
      mk(blowup([350, 330, 340, 414, 372, 351, 307, 410, 376, 421, 359, 427, 425, 415])),
    );
    expect(totalReps(out)).toBe(14);
  });
  it("leaves a genuine sequence (3,2,1 km, reps:1 per step) untouched", () => {
    const seq = [
      {
        set_reps: 3,
        steps: [
          { reps: 1, work_type: "DISTANCE" as const, work_value: 3000 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 2000 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 1000 },
        ],
      },
    ];
    const out = reconcileStructureBlowup(mk(seq));
    expect(out.structure).toEqual(seq);
  });
  it("leaves a clean single step (8x1000m) untouched", () => {
    const s = [{ set_reps: 1, steps: [{ reps: 8, work_type: "DISTANCE" as const, work_value: 1000 }] }];
    const out = reconcileStructureBlowup(mk(s));
    expect(out.structure).toEqual(s);
  });
  it("does not collapse 2 steps x reps 2 (N<3 guard, avoids touching small ambiguous sets)", () => {
    const s = blowup([400, 300]);
    const out = reconcileStructureBlowup(mk(s));
    expect(totalReps(out)).toBe(4);
  });
  it("does not collapse when reps != step count (3 steps but reps:1)", () => {
    const s = [
      {
        set_reps: 1,
        steps: [
          { reps: 1, work_type: "DISTANCE" as const, work_value: 400 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 400 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 400 },
        ],
      },
    ];
    expect(reconcileStructureBlowup(mk(s)).structure).toEqual(s);
  });
  it("leaves output untouched when structure is missing", () => {
    expect(reconcileStructureBlowup(mk(null)).structure).toBeNull();
  });
});
