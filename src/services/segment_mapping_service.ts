import type { SegmentBoundary } from "../agent/graph_state";
import { logger } from "../logger";
import type { TargetTypeEnum, WorkoutPartType } from "../schema/enums";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { ExpandedIntervalSet, ExpandedIntervalStep } from "../types/ExpandedIntervalSet";
import type { StreamSet } from "../types/strava/IStream";
import { calculateSegmentStats } from "./utils";

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

type SegStats = {
  actualDuration: number;
  actualDistance: number;
  avgHeartRate: number | null;
  timeSeriesEndTime: number;
};

export type FullSegmentSpec = {
  type: WorkoutPartType;
  setGroupIndex: number;
  targetType: TargetTypeEnum;
  targetValue: number;
  targetPace: number | null;
  timeSeriesEndTime: number;
};

export class SegmentMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentMappingError";
  }
}

const zeroStats = (end: number): SegStats => ({
  actualDuration: 0,
  actualDistance: 0,
  avgHeartRate: null,
  timeSeriesEndTime: end,
});

function assertInRange(endTimes: number[], t0: number, tEnd: number): void {
  for (const end of endTimes) {
    if (end < t0 || end > tEnd) {
      throw new SegmentMappingError(
        `Boundary endTime ${end} is outside the activity range [${t0}, ${tEnd}]`,
      );
    }
  }
}

function statsForBoundaries(
  streams: StatsStreams,
  sortedEndTimes: number[],
  tag: string,
): SegStats[] {
  const log = logger.child({ fn: "statsForBoundaries" });
  const t0 = streams.time.data[0] ?? 0;
  let prevEnd = t0;
  let dropped = 0;
  const out = sortedEndTimes.map((end) => {
    const start = prevEnd;
    let stats = end <= start ? zeroStats(end) : calculateSegmentStats(streams, start, end);
    if (!stats) {
      dropped += 1;
      stats = zeroStats(end);
    }
    prevEnd = stats.timeSeriesEndTime;
    return stats;
  });
  if (dropped > 0)
    log.warn({ tag, dropped }, "some segments got zero stats (start>=end or no samples)");
  return out;
}

function workTargets(step: ExpandedIntervalStep | undefined): {
  targetType: TargetTypeEnum;
  targetValue: number;
  targetPace: number | null;
} {
  if (!step) {
    return { targetType: "custom", targetValue: 0, targetPace: null };
  }
  return {
    targetType: step.work_type === "DISTANCE" ? "distance" : "time",
    targetValue: step.work_value,
    targetPace: step.target_pace ?? null,
  };
}

function restTargets(step: ExpandedIntervalStep | undefined): {
  targetType: TargetTypeEnum;
  targetValue: number;
} {
  if (!step) {
    return { targetType: "custom", targetValue: 0 };
  }
  return {
    targetType: step.recovery_type === "DISTANCE" ? "distance" : "time",
    targetValue: step.recovery_value ?? 0,
  };
}

export function mapBoundariesToSegments(
  streams: StatsStreams,
  boundaries: SegmentBoundary[],
  userSets: ExpandedIntervalSet[],
  activityId: number,
  parentTag = "",
): InsertIntervalSegment[] {
  const tag = `${parentTag}[mapBoundariesToSegments]`;
  const log = logger.child({ fn: "mapBoundariesToSegments", activityId });

  if (boundaries.length === 0) {
    throw new SegmentMappingError("No segment boundaries to map");
  }

  const sorted = [...boundaries].sort((a, b) => a.timeSeriesEndTime - b.timeSeriesEndTime);
  if (sorted[0].type !== "WARMUP") {
    log.warn({ tag, firstType: sorted[0].type }, "first boundary is not WARMUP");
  }

  const steps: ExpandedIntervalStep[] = userSets.flatMap((set) => set.steps);
  let stepCursor = -1;
  const specs: FullSegmentSpec[] = sorted.map((b) => {
    if (b.type === "INTERVALS") {
      stepCursor += 1;
      return { ...b, ...workTargets(steps[stepCursor]) };
    }
    if (b.type === "REST" || b.type === "ACTIVE_REST") {
      return { ...b, ...restTargets(steps[stepCursor]), targetPace: null };
    }
    return { ...b, targetType: "custom", targetValue: 0, targetPace: null };
  });

  return recomputeSegmentStats(streams, specs, activityId, parentTag);
}

export function recomputeSegmentStats(
  streams: StatsStreams,
  specs: FullSegmentSpec[],
  activityId: number,
  parentTag = "",
): InsertIntervalSegment[] {
  const tag = `${parentTag}[recomputeSegmentStats]`;
  if (specs.length === 0) {
    throw new SegmentMappingError("No segments to recompute");
  }

  const timeData = streams.time.data;
  const t0 = timeData[0] ?? 0;
  const tEnd = timeData[timeData.length - 1] ?? t0;

  const sorted = [...specs].sort((a, b) => a.timeSeriesEndTime - b.timeSeriesEndTime);
  assertInRange(
    sorted.map((s) => s.timeSeriesEndTime),
    t0,
    tEnd,
  );

  const stats = statsForBoundaries(
    streams,
    sorted.map((s) => s.timeSeriesEndTime),
    tag,
  );

  return sorted.map((s, i) => ({
    activityId,
    segmentIndex: i,
    setGroupIndex: Math.max(0, s.setGroupIndex),
    type: s.type,
    targetType: s.targetType,
    targetValue: s.targetValue,
    targetPace: s.targetPace,
    timeSeriesEndTime: stats[i].timeSeriesEndTime,
    actualDistance: stats[i].actualDistance,
    actualDuration: stats[i].actualDuration,
    avgHeartRate: stats[i].avgHeartRate,
  }));
}

export function toBoundaries(
  segments: { type: SegmentBoundary["type"]; setGroupIndex: number; timeSeriesEndTime: number }[],
): SegmentBoundary[] {
  return segments.map((s) => ({
    type: s.type,
    setGroupIndex: s.setGroupIndex,
    timeSeriesEndTime: s.timeSeriesEndTime,
  }));
}
