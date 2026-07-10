import { describe, expect, it } from "bun:test";
import type { WorkoutAnalysisOutput, workoutSet } from "../src/agent/initial_analysis_agent";
import {
  rebuildSetsWithDeclaredPaces,
  reconcileStructureTowardDeclared,
} from "../src/services/text_intent_service";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { z } from "zod";

type Set = z.infer<typeof workoutSet>;

const mk = (training_type: string, structure: Set[] | null): WorkoutAnalysisOutput =>
  ({
    classification_reasoning: "x",
    training_type,
    confidence_score: 0.9,
    structure,
  }) as unknown as WorkoutAnalysisOutput;

const dist = (reps: number, work_value: number, extra: Partial<Set["steps"][number]> = {}): Set => ({
  set_reps: 1,
  steps: [{ reps, work_type: "DISTANCE", work_value, ...extra }],
});
const time = (reps: number, work_value: number): Set => ({
  set_reps: 1,
  steps: [{ reps, work_type: "TIME", work_value }],
});
const totalReps = (structure: WorkoutAnalysisOutput["structure"]): number =>
  (structure ?? []).reduce(
    (n, s) => n + (s.set_reps ?? 1) * s.steps.reduce((a, st) => a + (st.reps ?? 1), 0),
    0,
  );

describe("reconcileStructureTowardDeclared", () => {
  it("adopts the declared rep count (declared 10×1000m over model 8×1000m)", () => {
    const { result, changed } = reconcileStructureTowardDeclared(
      mk("LONG_INTERVALS", [dist(8, 1000)]),
      [dist(10, 1000)],
    );
    expect(totalReps(result.structure)).toBe(10);
    expect(changed).toBe(true);
  });

  it("reclassifies a misclassified EASY toward LONG_INTERVALS from the declared reps", () => {
    const { result, changed } = reconcileStructureTowardDeclared(mk("EASY", null), [dist(10, 1000)]);
    expect(result.training_type).toBe("LONG_INTERVALS");
    expect(totalReps(result.structure)).toBe(10);
    expect(changed).toBe(true);
  });

  it("flips SHORT_INTERVALS to LONG via the subtype gate (declared 6×6min)", () => {
    const { result } = reconcileStructureTowardDeclared(mk("SHORT_INTERVALS", [time(20, 45)]), [
      time(6, 360),
    ]);
    expect(result.training_type).toBe("LONG_INTERVALS");
  });

  it("keeps model recovery values where declared shape doesn't specify them (aligned)", () => {
    const model = mk("LONG_INTERVALS", [
      dist(5, 1000, { recovery_type: "TIME", recovery_value: 90 }),
    ]);
    const { result, changed } = reconcileStructureTowardDeclared(model, [dist(6, 1000)]);
    const step = (result.structure ?? [])[0].steps[0];
    expect(step.reps).toBe(6); // declared work wins
    expect(step.recovery_value).toBe(90); // model recovery carried over
    expect(step.recovery_type).toBe("TIME");
    expect(changed).toBe(true);
  });

  it("treats declared recovery_value 0 / set_recovery 0 as unspecified (real gpt-4o-mini shape)", () => {
    const model = mk("LONG_INTERVALS", [
      { ...dist(8, 1000, { recovery_type: "TIME", recovery_value: 90 }), set_recovery: 300 },
    ]);
    const { result } = reconcileStructureTowardDeclared(model, [
      { ...dist(10, 1000, { recovery_type: null, recovery_value: 0 }), set_recovery: 0 },
    ]);
    const set = (result.structure ?? [])[0];
    expect(set.steps[0].reps).toBe(10);
    expect(set.steps[0].recovery_value).toBe(90); // 0 = unspecified → model recovery kept
    expect(set.steps[0].recovery_type).toBe("TIME"); // type follows value as a pair
    expect(set.set_recovery).toBe(300);
  });

  it("declared non-zero recovery wins as a pair over the model's", () => {
    const model = mk("LONG_INTERVALS", [
      dist(10, 1000, { recovery_type: "TIME", recovery_value: 90 }),
    ]);
    const { result } = reconcileStructureTowardDeclared(model, [
      dist(10, 1000, { recovery_type: "DISTANCE", recovery_value: 200 }),
    ]);
    const step = (result.structure ?? [])[0].steps[0];
    expect(step.recovery_type).toBe("DISTANCE");
    expect(step.recovery_value).toBe(200);
  });

  it("uses declared sets verbatim when shapes don't align", () => {
    const model = mk("LONG_INTERVALS", [
      {
        set_reps: 1,
        steps: [
          { reps: 4, work_type: "DISTANCE", work_value: 1000 },
          { reps: 20, work_type: "TIME", work_value: 45 },
        ],
      },
    ]);
    const declared: Set[] = [dist(4, 1000), time(20, 45)];
    const { result, changed } = reconcileStructureTowardDeclared(model, declared);
    expect(result.structure).toEqual(declared);
    expect(changed).toBe(true);
  });

  it("reports changed:false when the declared shape equals the model's", () => {
    const same = [dist(5, 1000)];
    const { result, changed } = reconcileStructureTowardDeclared(
      mk("LONG_INTERVALS", [dist(5, 1000)]),
      same,
    );
    expect(changed).toBe(false);
    expect(result.training_type).toBe("LONG_INTERVALS");
  });
});

describe("rebuildSetsWithDeclaredPaces", () => {
  const prevWithPaces = (n: number): ExpandedIntervalSet[] => [
    {
      set_recovery: null,
      steps: Array.from({ length: n }, (_, i) => ({
        work_type: "DISTANCE" as const,
        work_value: 1000,
        recovery_type: null,
        recovery_value: null,
        target_pace: i + 1, // 1..n, distinct per step
      })),
    },
  ];
  const flatPaces = (sets: ExpandedIntervalSet[]): (number | null)[] =>
    sets.flatMap((s) => s.steps.map((st) => st.target_pace ?? null));

  it("carries the first N paces when the declared structure shrinks (8 vs 10)", () => {
    const out = rebuildSetsWithDeclaredPaces(
      [{ set_reps: 1, steps: [{ reps: 8, work_type: "DISTANCE", work_value: 1000 }] }],
      prevWithPaces(10),
    );
    const paces = flatPaces(out);
    expect(paces).toHaveLength(8);
    expect(paces).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives extra steps null pace when the declared structure grows (12 vs 10)", () => {
    const out = rebuildSetsWithDeclaredPaces(
      [{ set_reps: 1, steps: [{ reps: 12, work_type: "DISTANCE", work_value: 1000 }] }],
      prevWithPaces(10),
    );
    const paces = flatPaces(out);
    expect(paces).toHaveLength(12);
    expect(paces.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(paces.slice(10)).toEqual([null, null]);
  });
});
