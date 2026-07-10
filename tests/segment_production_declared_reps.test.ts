import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fullAnalysis from "../src/agent/full_analysis_agent";
import { produceSegments } from "../src/agent/segment_production";
import { logger } from "../src/logger";
import type { InsertIntervalSegment } from "../src/schema/interval_segments";
import * as deterministic from "../src/services/deterministic_segmenter";
import * as lapDeriv from "../src/services/lap_derivation_service";

// Shape enforcement (item 4): when a text/notes-declared rep count is passed as
// `declaredReps`, a rung whose produced work count contradicts it must fall
// through to the next rung instead of shipping the wrong count. With declaredReps
// undefined the behavior is unchanged.

const interval = (i: number): InsertIntervalSegment => ({
  activityId: 1,
  segmentIndex: i,
  setGroupIndex: 1,
  type: "INTERVALS",
  targetType: "distance",
  targetValue: 1000,
  targetPace: null,
  timeSeriesEndTime: (i + 1) * 100,
  actualDistance: 1000,
  actualDuration: 100,
  avgHeartRate: null,
});
const intervals = (n: number): InsertIntervalSegment[] =>
  Array.from({ length: n }, (_, i) => interval(i));
const workCount = (segs: InsertIntervalSegment[]): number =>
  segs.filter((s) => s.type === "INTERVALS").length;

const statsStreams = {
  time: { data: [0, 100, 200, 300, 400, 500] },
  distance: { data: [0, 1000, 2000, 3000, 4000, 5000] },
} as Parameters<typeof produceSegments>[0]["statsStreams"];

const base = {
  activityId: 1,
  statsStreams,
  streams: statsStreams as never,
  isIndoor: false,
  userSets: [],
  initialResult: null,
  userNotes: "",
  trainingType: "LONG_INTERVALS" as const,
  intervalsIcuIntervals: null,
  log: logger.child({ test: "declaredReps" }),
  tag: "[test]",
};

describe("produceSegments declaredReps enforcement", () => {
  afterEach(() => {
    lapSpyMatch?.mockRestore();
    lapSpyBuild?.mockRestore();
    detSpy?.mockRestore();
    llmSpy?.mockRestore();
    lapSpyMatch = lapSpyBuild = detSpy = llmSpy = undefined;
  });

  let lapSpyMatch: ReturnType<typeof spyOn> | undefined;
  let lapSpyBuild: ReturnType<typeof spyOn> | undefined;
  let detSpy: ReturnType<typeof spyOn> | undefined;
  let llmSpy: ReturnType<typeof spyOn> | undefined;

  it("returns the lap rung when declaredReps is undefined (unchanged behavior)", async () => {
    lapSpyMatch = spyOn(lapDeriv, "structureShapeMatches").mockReturnValue(true);
    lapSpyBuild = spyOn(lapDeriv, "buildSegmentsFromLaps").mockReturnValue(intervals(3));
    detSpy = spyOn(deterministic, "buildSegmentsDeterministic");

    const out = await produceSegments({ ...base, laps: [{}, {}] as never });

    expect(workCount(out)).toBe(3);
    expect(detSpy).toHaveBeenCalledTimes(0);
  });

  it("falls through the lap rung when its work count contradicts declaredReps", async () => {
    lapSpyMatch = spyOn(lapDeriv, "structureShapeMatches").mockReturnValue(true);
    lapSpyBuild = spyOn(lapDeriv, "buildSegmentsFromLaps").mockReturnValue(intervals(3));
    detSpy = spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue({
      segments: intervals(5),
      confidence: 1,
      mode: "laps",
    } as never);

    const out = await produceSegments({ ...base, laps: [{}, {}] as never, declaredReps: 5 });

    expect(lapSpyBuild).toHaveBeenCalledTimes(1);
    expect(workCount(out)).toBe(5); // deterministic result, not the lap's 3
  });

  it("returns the deterministic rung when declaredReps is undefined (unchanged behavior)", async () => {
    detSpy = spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue({
      segments: intervals(3),
      confidence: 1,
      mode: "laps",
    } as never);
    llmSpy = spyOn(fullAnalysis, "invokeCompleteActivityAnalysisAgent");

    const out = await produceSegments({ ...base, laps: [] });

    expect(workCount(out)).toBe(3);
    expect(llmSpy).toHaveBeenCalledTimes(0);
  });

  it("falls through the deterministic rung to the LLM when it contradicts declaredReps", async () => {
    detSpy = spyOn(deterministic, "buildSegmentsDeterministic").mockReturnValue({
      segments: intervals(3),
      confidence: 1,
      mode: "laps",
    } as never);
    llmSpy = spyOn(fullAnalysis, "invokeCompleteActivityAnalysisAgent").mockResolvedValue({
      segments: [],
    } as never);

    await produceSegments({ ...base, laps: [], declaredReps: 5 });

    expect(llmSpy).toHaveBeenCalledTimes(1);
  });
});
