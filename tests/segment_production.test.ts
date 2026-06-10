import { describe, expect, it } from "bun:test";
import { ensureWarmupFirst } from "../src/agent/segment_production";
import type { InsertIntervalSegment } from "../src/schema/interval_segments";

function seg(overrides: Partial<InsertIntervalSegment>): InsertIntervalSegment {
  return {
    activityId: 1,
    segmentIndex: 0,
    setGroupIndex: 0,
    type: "INTERVALS",
    targetType: "distance",
    targetValue: 1000,
    targetPace: 3.5,
    timeSeriesEndTime: 100,
    actualDistance: 1000,
    actualDuration: 300,
    avgHeartRate: 160,
    ...overrides,
  };
}

describe("ensureWarmupFirst", () => {
  it("returns the input unchanged when it already starts with WARMUP", () => {
    const input = [
      seg({ type: "WARMUP", segmentIndex: 0, timeSeriesEndTime: 60 }),
      seg({ type: "INTERVALS", segmentIndex: 1, timeSeriesEndTime: 120 }),
    ];
    expect(ensureWarmupFirst(input, 1, 0)).toBe(input);
  });

  it("returns an empty array unchanged", () => {
    const input: InsertIntervalSegment[] = [];
    expect(ensureWarmupFirst(input, 1, 0)).toBe(input);
  });

  it("prepends a zero-length WARMUP at t0 and re-indexes when missing", () => {
    const input = [
      seg({ type: "INTERVALS", segmentIndex: 0, timeSeriesEndTime: 120 }),
      seg({ type: "REST", segmentIndex: 1, timeSeriesEndTime: 150 }),
    ];

    const out = ensureWarmupFirst(input, 99, 5);

    expect(out).toHaveLength(3);
    expect(out.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
    expect(out.map((s) => s.type)).toEqual(["WARMUP", "INTERVALS", "REST"]);
    expect(out[0]).toMatchObject({
      type: "WARMUP",
      activityId: 99,
      timeSeriesEndTime: 5,
      actualDistance: 0,
      actualDuration: 0,
      avgHeartRate: null,
      targetType: "custom",
      targetValue: 0,
      targetPace: null,
    });
  });
});
