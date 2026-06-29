import { describe, expect, it } from "bun:test";
import {
  expandRestSegments,
  foldRestSegments,
} from "../src/services/segment_fold_service";
import type { InsertIntervalSegment, SelectIntervalSegment } from "../src/schema/interval_segments";

function ins(o: Partial<InsertIntervalSegment>): InsertIntervalSegment {
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
    ...o,
  };
}

// warmup, work1, rest1, work2, rest2, cooldown
function expanded(): InsertIntervalSegment[] {
  return [
    ins({ type: "WARMUP", segmentIndex: 0, timeSeriesEndTime: 60, targetType: "custom", targetValue: 0, targetPace: null }),
    ins({ type: "INTERVALS", segmentIndex: 1, timeSeriesEndTime: 160 }),
    ins({ type: "REST", segmentIndex: 2, timeSeriesEndTime: 200, targetType: "time", targetValue: 60, targetPace: null, actualDistance: 80, actualDuration: 40, avgHeartRate: 140 }),
    ins({ type: "INTERVALS", segmentIndex: 3, timeSeriesEndTime: 300 }),
    ins({ type: "REST", segmentIndex: 4, timeSeriesEndTime: 340, targetType: "time", targetValue: 60, targetPace: null, actualDistance: 70, actualDuration: 40, avgHeartRate: 138 }),
    ins({ type: "COOL_DOWN", segmentIndex: 5, timeSeriesEndTime: 600, targetType: "custom", targetValue: 0, targetPace: null }),
  ];
}

describe("foldRestSegments", () => {
  it("removes normal REST rows and folds them onto the preceding work row", () => {
    const folded = foldRestSegments(expanded());
    expect(folded.map((s) => s.type)).toEqual(["WARMUP", "INTERVALS", "INTERVALS", "COOL_DOWN"]);
    expect(folded.some((s) => s.type === "REST")).toBe(false);
  });

  it("carries the rest's prescribed + actual recovery onto the work row", () => {
    const folded = foldRestSegments(expanded());
    const work1 = folded[1];
    expect(work1.recoveryTargetType).toBe("time");
    expect(work1.recoveryTargetValue).toBe(60);
    expect(work1.recoveryEndTime).toBe(200);
    expect(work1.recoveryDistance).toBe(80);
    expect(work1.recoveryDuration).toBe(40);
    expect(work1.recoveryAvgHeartRate).toBe(140);
    // work row's own work fields untouched (timeSeriesEndTime = end of WORK)
    expect(work1.timeSeriesEndTime).toBe(160);
    expect(work1.actualDuration).toBe(300);
  });

  it("re-indexes contiguously after dropping rests", () => {
    const folded = foldRestSegments(expanded());
    expect(folded.map((s) => s.segmentIndex)).toEqual([0, 1, 2, 3]);
  });

  it("leaves ACTIVE_REST as its own row", () => {
    const withActive: InsertIntervalSegment[] = [
      ins({ type: "INTERVALS", segmentIndex: 0, timeSeriesEndTime: 100 }),
      ins({ type: "ACTIVE_REST", segmentIndex: 1, timeSeriesEndTime: 200, targetType: "distance", targetValue: 1000 }),
      ins({ type: "INTERVALS", segmentIndex: 2, timeSeriesEndTime: 300 }),
    ];
    const folded = foldRestSegments(withActive);
    expect(folded.map((s) => s.type)).toEqual(["INTERVALS", "ACTIVE_REST", "INTERVALS"]);
    expect(folded[0].recoveryEndTime).toBeNull();
  });

  it("does not fold a second consecutive REST (only the immediate one)", () => {
    const doubleRest: InsertIntervalSegment[] = [
      ins({ type: "INTERVALS", segmentIndex: 0, timeSeriesEndTime: 100 }),
      ins({ type: "REST", segmentIndex: 1, timeSeriesEndTime: 140, targetType: "time", targetValue: 40, targetPace: null }),
      ins({ type: "REST", segmentIndex: 2, timeSeriesEndTime: 180, targetType: "time", targetValue: 40, targetPace: null }),
    ];
    const folded = foldRestSegments(doubleRest);
    expect(folded.map((s) => s.type)).toEqual(["INTERVALS", "REST"]);
  });
});

describe("expandRestSegments", () => {
  it("reconstructs the work + REST list from folded rows", () => {
    const folded = foldRestSegments(expanded()) as unknown as SelectIntervalSegment[];
    const withIds = folded.map((s, i) => ({ ...s, id: i + 1 }) as SelectIntervalSegment);
    const back = expandRestSegments(withIds);
    expect(back.map((s) => s.type)).toEqual(expanded().map((s) => s.type));
  });

  it("restores the rest's actual stats and clears recovery fields on the work row", () => {
    const folded = foldRestSegments(expanded()).map(
      (s, i) => ({ ...s, id: i + 1 }) as SelectIntervalSegment,
    );
    const back = expandRestSegments(folded);
    const rest1 = back[2];
    expect(rest1.type).toBe("REST");
    expect(rest1.timeSeriesEndTime).toBe(200);
    expect(rest1.actualDuration).toBe(40);
    expect(rest1.actualDistance).toBe(80);
    expect(rest1.avgHeartRate).toBe(140);
    expect(rest1.targetValue).toBe(60);
    // the work row no longer carries recovery after expansion
    expect(back[1].recoveryEndTime).toBeNull();
  });

  it("round-trips: expand(fold(x)) matches x in shape, types, and rest stats", () => {
    const original = expanded();
    const folded = foldRestSegments(original).map(
      (s, i) => ({ ...s, id: i + 1 }) as SelectIntervalSegment,
    );
    const back = expandRestSegments(folded);
    expect(back.map((s) => s.type)).toEqual(original.map((s) => s.type));
    expect(back.map((s) => s.timeSeriesEndTime)).toEqual(
      original.map((s) => s.timeSeriesEndTime),
    );
    expect(back.map((s) => s.segmentIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
