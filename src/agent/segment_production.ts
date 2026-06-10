import type { Logger } from "../logger";
import type { TrainingType } from "../schema/enums";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import { buildSegmentsFromLaps, structureShapeMatches } from "../services/lap_derivation_service";
import { calculateSegmentStats, parsePaceStringToMetersPerSecond } from "../services/utils";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import { invokeCompleteActivityAnalysisAgent } from "./full_analysis_agent";
import type { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { invokeWithRateLimitRetry } from "./model";

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

export function ensureWarmupFirst(
  segments: InsertIntervalSegment[],
  activityId: number,
  t0: number,
): InsertIntervalSegment[] {
  if (segments.length === 0 || segments[0].type === "WARMUP") return segments;
  const warmup: InsertIntervalSegment = {
    activityId,
    segmentIndex: 0,
    setGroupIndex: 0,
    type: "WARMUP",
    targetType: "custom",
    targetValue: 0,
    targetPace: null,
    timeSeriesEndTime: t0,
    actualDistance: 0,
    actualDuration: 0,
    avgHeartRate: null,
  };
  return [warmup, ...segments].map((s, i) => ({ ...s, segmentIndex: i }));
}

export async function produceSegments(params: {
  activityId: number;
  statsStreams: StatsStreams;
  streams: StreamSet;
  laps: Lap[];
  isIndoor: boolean;
  userSets: ExpandedIntervalSet[];
  initialResult: WorkoutAnalysisOutput | null;
  userNotes: string;
  trainingType: TrainingType;
  log: Logger;
  tag: string;
}): Promise<InsertIntervalSegment[]> {
  const { activityId, statsStreams, streams, laps, isIndoor, userSets, initialResult, log } =
    params;
  const t0 = statsStreams.time.data[0] ?? 0;

  const shapeUnchanged = structureShapeMatches(initialResult?.structure, userSets);
  if (shapeUnchanged && !isIndoor && laps.length > 0) {
    log.info("structure unchanged + outdoor — attempting lap-derived segments");
    const fromLaps = buildSegmentsFromLaps(activityId, laps, userSets, statsStreams, params.tag);
    if (fromLaps) {
      log.info({ segments: fromLaps.length }, "lap-derived segments");
      return ensureWarmupFirst(fromLaps, activityId, t0);
    }
    log.info("lap-derivation failed — falling back to LLM");
  } else {
    log.info({ shapeUnchanged, indoor: isIndoor, laps: laps.length }, "skipping lap-derived path");
  }

  log.info("invoking segmentation LLM");
  const segmentPlan = await invokeWithRateLimitRetry(() =>
    invokeCompleteActivityAnalysisAgent(
      streams,
      params.userNotes,
      params.trainingType,
      laps,
      initialResult,
      userSets,
    ),
  );
  if (!segmentPlan) {
    throw new Error("Segmentation agent returned null");
  }
  log.info({ rawSegments: segmentPlan.segments.length }, "LLM returned segments");

  let segmentIndexCounter = 0;
  let droppedByStats = 0;
  const computed = segmentPlan.segments
    .map((seg) => {
      const stats = calculateSegmentStats(statsStreams, seg.start_time, seg.end_time);
      if (!stats) {
        droppedByStats += 1;
        return null;
      }
      return {
        activityId,
        segmentIndex: segmentIndexCounter++,
        setGroupIndex: seg.set_group_index ?? 0,
        type: seg.type,
        targetType: seg.target_type,
        targetValue: seg.target_value,
        targetPace: parsePaceStringToMetersPerSecond(seg.target_pace_string ?? ""),
        timeSeriesEndTime: stats.timeSeriesEndTime,
        actualDistance: stats.actualDistance,
        actualDuration: stats.actualDuration,
        avgHeartRate: stats.avgHeartRate,
      } satisfies InsertIntervalSegment;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  log.info({ computed: computed.length, droppedByStats }, "LLM segments computed");
  return ensureWarmupFirst(computed, activityId, t0);
}
