import { describe, expect, it } from "bun:test";
import { reconcileIntervalSubtype } from "../src/agent/initial_analysis_agent";

// Pure guardrail: reconcile SHORT vs LONG intervals against the model's own
// extracted structure (a rep >=120s OR >=800m -> LONG). Fixes gpt-4o-mini's
// occasional inequality flip (observed: "7x4min = 240s; 240 < 120 -> SHORT").
type Out = Parameters<typeof reconcileIntervalSubtype>[0];
const mk = (training_type: string, structure: unknown): Out =>
  ({ classification_reasoning: "x", training_type, confidence_score: 0.9, structure }) as Out;
const time = (reps: number, work_value: number) => ({
  set_reps: 1,
  steps: [{ reps, work_type: "TIME" as const, work_value }],
});
const dist = (reps: number, work_value: number) => ({
  set_reps: 1,
  steps: [{ reps, work_type: "DISTANCE" as const, work_value }],
});

describe("reconcileIntervalSubtype", () => {
  it("flips SHORT->LONG when a TIME rep is >=120s (the 7x4min arithmetic slip)", () => {
    expect(reconcileIntervalSubtype(mk("SHORT_INTERVALS", [time(7, 240)])).training_type).toBe(
      "LONG_INTERVALS",
    );
  });
  it("keeps SHORT when all TIME reps are <120s (20x90s)", () => {
    expect(reconcileIntervalSubtype(mk("SHORT_INTERVALS", [time(20, 90)])).training_type).toBe(
      "SHORT_INTERVALS",
    );
  });
  it("flips SHORT->LONG when a DISTANCE rep is >=800m (8x1000m)", () => {
    expect(reconcileIntervalSubtype(mk("SHORT_INTERVALS", [dist(8, 1000)])).training_type).toBe(
      "LONG_INTERVALS",
    );
  });
  it("flips LONG->SHORT when all DISTANCE reps are <800m (10x400m)", () => {
    expect(reconcileIntervalSubtype(mk("LONG_INTERVALS", [dist(10, 400)])).training_type).toBe(
      "SHORT_INTERVALS",
    );
  });
  it("treats a pyramid with any long rep as LONG (3x(3,2,1km))", () => {
    const s = [
      {
        set_reps: 3,
        steps: [
          { reps: 1, work_type: "DISTANCE" as const, work_value: 3000 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 2000 },
          { reps: 1, work_type: "DISTANCE" as const, work_value: 1000 },
        ],
      },
    ];
    expect(reconcileIntervalSubtype(mk("SHORT_INTERVALS", s)).training_type).toBe("LONG_INTERVALS");
  });
  it("leaves non-interval types untouched (EASY)", () => {
    expect(reconcileIntervalSubtype(mk("EASY", [time(7, 240)])).training_type).toBe("EASY");
  });
  it("leaves output untouched when structure is missing", () => {
    expect(reconcileIntervalSubtype(mk("SHORT_INTERVALS", null)).training_type).toBe(
      "SHORT_INTERVALS",
    );
  });
  it("keeps a correct LONG (6x6min) as LONG", () => {
    expect(reconcileIntervalSubtype(mk("LONG_INTERVALS", [time(6, 360)])).training_type).toBe(
      "LONG_INTERVALS",
    );
  });
});
