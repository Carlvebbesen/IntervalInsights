import { describe, expect, it } from "bun:test";
import {
  clampVolumeRamp,
  EASY_PACE_MPS,
  estimateStructureDistanceMeters,
  expectedWeekStarts,
  repairSessionDate,
  stripPaces,
} from "../src/agent/planning/guards";
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
