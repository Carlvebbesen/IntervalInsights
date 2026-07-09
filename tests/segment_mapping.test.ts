import { describe, expect, it } from "bun:test";
import {
  boundariesMatchUserShape,
  type FullSegmentSpec,
  mapBoundariesToSegments,
  recomputeSegmentStats,
  SegmentMappingError,
  toBoundaries,
} from "../src/services/segment_mapping_service";
import type { SegmentBoundary } from "../src/agent/graph_state";
import type {
  ExpandedIntervalSet,
  ExpandedIntervalStep,
} from "../src/types/ExpandedIntervalSet";

function streams() {
  return {
    time: { data: [0, 10, 20, 30, 40, 50, 60] },
    distance: { data: [0, 30, 60, 90, 120, 150, 180] },
    heartrate: { data: [100, 110, 120, 130, 140, 150, 160] },
  };
}

const oneStepSet: ExpandedIntervalSet[] = [
  {
    steps: [
      {
        work_type: "DISTANCE",
        work_value: 60,
        recovery_type: "TIME",
        recovery_value: 30,
        target_pace: 3.5,
      },
    ],
  },
];

describe("mapBoundariesToSegments", () => {
  it("maps WARMUP/INTERVALS/REST/COOL_DOWN with targets from userSets and recomputed stats", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 40 },
      { type: "REST", setGroupIndex: 1, timeSeriesEndTime: 50 },
      { type: "COOL_DOWN", setGroupIndex: 0, timeSeriesEndTime: 60 },
    ];

    const out = mapBoundariesToSegments(streams(), boundaries, oneStepSet, 42);

    expect(out).toHaveLength(4);
    expect(out.map((s) => s.segmentIndex)).toEqual([0, 1, 2, 3]);
    expect(out.map((s) => s.type)).toEqual(["WARMUP", "INTERVALS", "REST", "COOL_DOWN"]);

    expect(out[0]).toMatchObject({
      type: "WARMUP",
      setGroupIndex: 0,
      targetType: "custom",
      targetValue: 0,
      targetPace: null,
      timeSeriesEndTime: 20,
      actualDuration: 20,
      actualDistance: 60,
      avgHeartRate: 110,
      activityId: 42,
    });
    expect(out[1]).toMatchObject({
      type: "INTERVALS",
      setGroupIndex: 1,
      targetType: "distance",
      targetValue: 60,
      targetPace: 3.5,
      timeSeriesEndTime: 40,
      actualDuration: 20,
      actualDistance: 60,
      avgHeartRate: 130,
    });
    expect(out[2]).toMatchObject({
      type: "REST",
      targetType: "time",
      targetValue: 30,
      targetPace: null,
      timeSeriesEndTime: 50,
      actualDuration: 10,
      actualDistance: 30,
      avgHeartRate: 145,
    });
    expect(out[3]).toMatchObject({
      type: "COOL_DOWN",
      targetType: "custom",
      targetValue: 0,
      targetPace: null,
      timeSeriesEndTime: 60,
      actualDuration: 10,
      actualDistance: 30,
      avgHeartRate: 155,
    });
  });

  it("keeps a zero-length WARMUP (end == start) instead of dropping it", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 0 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 30 },
      { type: "COOL_DOWN", setGroupIndex: 0, timeSeriesEndTime: 60 },
    ];

    const out = mapBoundariesToSegments(streams(), boundaries, oneStepSet, 1);

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      type: "WARMUP",
      timeSeriesEndTime: 0,
      actualDuration: 0,
      actualDistance: 0,
      avgHeartRate: null,
    });
    expect(out[1].type).toBe("INTERVALS");
  });

  it("sorts boundaries by end time before mapping", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "COOL_DOWN", setGroupIndex: 0, timeSeriesEndTime: 60 },
      { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 40 },
    ];

    const out = mapBoundariesToSegments(streams(), boundaries, oneStepSet, 1);

    expect(out.map((s) => s.timeSeriesEndTime)).toEqual([20, 40, 60]);
    expect(out.map((s) => s.type)).toEqual(["WARMUP", "INTERVALS", "COOL_DOWN"]);
  });

  it("falls back to custom/0/null when there are more INTERVALS than userSets steps", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 10 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 30 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 60 },
    ];

    const out = mapBoundariesToSegments(streams(), boundaries, oneStepSet, 1);

    expect(out[1]).toMatchObject({ targetType: "distance", targetValue: 60, targetPace: 3.5 });
    expect(out[2]).toMatchObject({ targetType: "custom", targetValue: 0, targetPace: null });
  });

  it("clamps negative setGroupIndex to 0", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "WARMUP", setGroupIndex: -5, timeSeriesEndTime: 60 },
    ];
    const out = mapBoundariesToSegments(streams(), boundaries, oneStepSet, 1);
    expect(out[0].setGroupIndex).toBe(0);
  });

  it("throws SegmentMappingError on empty boundaries", () => {
    expect(() => mapBoundariesToSegments(streams(), [], oneStepSet, 1)).toThrow(SegmentMappingError);
  });

  it("throws SegmentMappingError when a boundary is outside the activity range", () => {
    const boundaries: SegmentBoundary[] = [
      { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20 },
      { type: "INTERVALS", setGroupIndex: 1, timeSeriesEndTime: 999 },
    ];
    expect(() => mapBoundariesToSegments(streams(), boundaries, oneStepSet, 1)).toThrow(
      SegmentMappingError,
    );
  });
});

describe("recomputeSegmentStats", () => {
  it("keeps client-supplied targets and recomputes stats from the streams", () => {
    const specs: FullSegmentSpec[] = [
      {
        type: "WARMUP",
        setGroupIndex: 0,
        targetType: "custom",
        targetValue: 0,
        targetPace: null,
        timeSeriesEndTime: 20,
      },
      {
        type: "INTERVALS",
        setGroupIndex: 1,
        targetType: "distance",
        targetValue: 1000,
        targetPace: 3.2,
        timeSeriesEndTime: 60,
      },
    ];

    const out = recomputeSegmentStats(streams(), specs, 7);

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      type: "INTERVALS",
      targetType: "distance",
      targetValue: 1000,
      targetPace: 3.2,
      timeSeriesEndTime: 60,
      actualDuration: 40,
      actualDistance: 120,
      activityId: 7,
      segmentIndex: 1,
    });
  });

  it("throws SegmentMappingError on empty specs", () => {
    expect(() => recomputeSegmentStats(streams(), [], 1)).toThrow(SegmentMappingError);
  });

  it("throws SegmentMappingError when a spec is outside the activity range", () => {
    const specs: FullSegmentSpec[] = [
      {
        type: "WARMUP",
        setGroupIndex: 0,
        targetType: "custom",
        targetValue: 0,
        targetPace: null,
        timeSeriesEndTime: 9999,
      },
    ];
    expect(() => recomputeSegmentStats(streams(), specs, 1)).toThrow(SegmentMappingError);
  });
});

describe("toBoundaries", () => {
  it("projects full segments down to {type,setGroupIndex,timeSeriesEndTime}", () => {
    const full: {
      type: SegmentBoundary["type"];
      setGroupIndex: number;
      timeSeriesEndTime: number;
      actualDistance: number;
    }[] = [{ type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20, actualDistance: 60 }];
    const out = toBoundaries(full);
    expect(out).toEqual([{ type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 20 }]);
  });
});

describe("boundariesMatchUserShape", () => {
  const step: ExpandedIntervalStep = {
    work_type: "DISTANCE",
    work_value: 400,
    recovery_type: "TIME",
    recovery_value: 60,
    target_pace: 3.5,
  };
  const setWith = (n: number): ExpandedIntervalSet => ({ steps: Array.from({ length: n }, () => step) });
  const workBoundaries = (n: number): SegmentBoundary[] => [
    { type: "WARMUP", setGroupIndex: 0, timeSeriesEndTime: 10 },
    ...Array.from({ length: n }, (_, i) => ({
      type: "INTERVALS" as const,
      setGroupIndex: 1,
      timeSeriesEndTime: 20 + i * 10,
    })),
    { type: "COOL_DOWN", setGroupIndex: 0, timeSeriesEndTime: 20 + n * 10 },
  ];

  it("matching work counts → true", () => {
    expect(boundariesMatchUserShape(workBoundaries(8), [setWith(8)])).toBe(true);
  });

  it("proposal 10 work boundaries vs 8 user steps → false", () => {
    expect(boundariesMatchUserShape(workBoundaries(10), [setWith(8)])).toBe(false);
  });

  it("empty userSets → true (nothing to enforce)", () => {
    expect(boundariesMatchUserShape(workBoundaries(10), [])).toBe(true);
  });
});
