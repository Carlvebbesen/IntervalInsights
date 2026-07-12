import { describe, expect, test } from "bun:test";
import type { StreamSet } from "../types/strava/IStream";
import {
  computeActivityHrStats,
  computeHrStats,
  computeWorkHrStats,
  type WorkWindowSegment,
} from "./hr_stats_service";

describe("computeHrStats", () => {
  test("computes avg / max / median / mode and drops zero/negative samples", () => {
    const stats = computeHrStats([0, 120, 130, 130, 130, 140, 150, 160]);
    expect(stats).toEqual({ avg: 137, max: 160, median: 130, mode: 130 });
  });

  test("median of an even-length set is the mean of the two middle values", () => {
    expect(computeHrStats([100, 110, 120, 130])?.median).toBe(115);
  });

  test("mode is the most-frequent integer bpm (most time in HR)", () => {
    expect(computeHrStats([150, 150, 150, 160, 160, 170])?.mode).toBe(150);
  });

  test("mode ties break toward the lower bpm for determinism", () => {
    expect(computeHrStats([150, 150, 140, 140, 160])?.mode).toBe(140);
  });

  test("rounds fractional samples for avg, median and mode bucketing", () => {
    const stats = computeHrStats([100.4, 100.4, 101.6]);
    expect(stats).toEqual({ avg: 101, max: 102, median: 100, mode: 100 });
  });

  test("single sample yields that value for every metric", () => {
    expect(computeHrStats([142])).toEqual({ avg: 142, max: 142, median: 142, mode: 142 });
  });

  test("returns null when there are no usable samples", () => {
    expect(computeHrStats([])).toBeNull();
    expect(computeHrStats([0, 0, -5])).toBeNull();
  });
});

describe("computeActivityHrStats", () => {
  test("computes over the heartrate stream", () => {
    const streams = { heartrate: { data: [120, 130, 140] } } as Pick<StreamSet, "heartrate">;
    expect(computeActivityHrStats(streams)).toEqual({
      avg: 130,
      max: 140,
      median: 130,
      mode: 120,
    });
  });

  test("returns null when the heartrate stream is missing", () => {
    expect(computeActivityHrStats({} as Pick<StreamSet, "heartrate">)).toBeNull();
  });
});

describe("computeWorkHrStats", () => {
  const streams = {
    time: { data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    heartrate: { data: [100, 150, 152, 154, 100, 100, 160, 162, 164, 100, 100] },
  } as Pick<StreamSet, "time" | "heartrate">;

  test("restricts metrics to INTERVALS windows and ignores rest/warmup", () => {
    const segments: WorkWindowSegment[] = [
      { type: "WARMUP", timeSeriesEndTime: 0, actualDuration: 0 },
      { type: "INTERVALS", timeSeriesEndTime: 3, actualDuration: 3 },
      { type: "REST", timeSeriesEndTime: 5, actualDuration: 2 },
      { type: "INTERVALS", timeSeriesEndTime: 8, actualDuration: 2 },
    ];
    expect(computeWorkHrStats(streams, segments)).toEqual({
      avg: 149,
      max: 164,
      median: 154,
      mode: 100,
    });
  });

  test("returns null when there are no work segments", () => {
    const segments: WorkWindowSegment[] = [
      { type: "WARMUP", timeSeriesEndTime: 2, actualDuration: 2 },
      { type: "REST", timeSeriesEndTime: 4, actualDuration: 2 },
    ];
    expect(computeWorkHrStats(streams, segments)).toBeNull();
  });

  test("returns null when the time or heartrate stream is missing", () => {
    const segments: WorkWindowSegment[] = [
      { type: "INTERVALS", timeSeriesEndTime: 3, actualDuration: 3 },
    ];
    expect(computeWorkHrStats({ heartrate: { data: [120] } }, segments)).toBeNull();
    expect(computeWorkHrStats({ time: { data: [0, 1] } }, segments)).toBeNull();
  });

  test("includes the boundary samples of the work window", () => {
    const segments: WorkWindowSegment[] = [
      { type: "INTERVALS", timeSeriesEndTime: 2, actualDuration: 1 },
    ];
    expect(computeWorkHrStats(streams, segments)).toEqual({
      avg: 151,
      max: 152,
      median: 151,
      mode: 150,
    });
  });
});
