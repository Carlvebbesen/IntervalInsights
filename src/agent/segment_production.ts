import type { Logger } from "../logger";
import type { TrainingType } from "../schema/enums";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import { buildSegmentsDeterministic } from "../services/deterministic_segmenter";
import { buildSegmentsFromIntervalsIcu } from "../services/intervals_icu_segments";
import { buildSegmentsFromLaps, structureShapeMatches } from "../services/lap_derivation_service";
import { SEGMENTER_CONFIG } from "../services/segmenter_config";
import { calculateSegmentStats, parsePaceStringToMetersPerSecond } from "../services/utils";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import { invokeCompleteActivityAnalysisAgent } from "./full_analysis_agent";
import type { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { invokeWithRateLimitRetry } from "./model";

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

const DETERMINISTIC_CONFIDENCE_THRESHOLD = SEGMENTER_CONFIG.cascade.deterministicThreshold;

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

/** Total work reps implied by an LLM-extracted structure (set_reps × Σ step.reps). */
export function countStructureReps(
  structure: WorkoutAnalysisOutput["structure"],
): number | undefined {
  if (!structure || structure.length === 0) return undefined;
  let n = 0;
  for (const set of structure) {
    const stepReps = set.steps.reduce((s, st) => s + (st.reps ?? 1), 0);
    n += (set.set_reps ?? 1) * stepReps;
  }
  return n > 0 ? n : undefined;
}

export async function produceSegments(params: {
  activityId: number;
  statsStreams: StatsStreams;
  streams: StreamSet;
  laps: Lap[];
  isIndoor: boolean;
  userSets: ExpandedIntervalSet[];
  initialResult: WorkoutAnalysisOutput | null;
  userNotes?: string;
  trainingType: TrainingType;
  intervalsIcuIntervals?: IIntervalsInterval[] | null;
  // Authoritative work-rep count from a text/notes-declared structure. When set,
  // a rung whose produced work count contradicts it is rejected (falls through to
  // the next rung) rather than shipping the wrong count. Undefined ⇒ no change.
  declaredReps?: number;
  log: Logger;
  tag: string;
}): Promise<InsertIntervalSegment[]> {
  const { activityId, statsStreams, streams, laps, userSets, initialResult, log } = params;
  const t0 = statsStreams.time.data[0] ?? 0;
  const userNotes = params.userNotes ?? "";
  const declaredReps = params.declaredReps;
  const workCount = (segments: InsertIntervalSegment[]): number =>
    segments.filter((s) => s.type === "INTERVALS").length;

  // Preferred rung: when the activity is linked to intervals.icu, its own
  // WORK/RECOVERY breakdown is authoritative — use it before any heuristic.
  const intervalsIcu = params.intervalsIcuIntervals;
  if (intervalsIcu && intervalsIcu.length > 0) {
    log.info({ intervals: intervalsIcu.length }, "intervals.icu linked — attempting its breakdown");
    const expectedReps = declaredReps ?? countStructureReps(initialResult?.structure);
    const fromIcu = buildSegmentsFromIntervalsIcu(
      activityId,
      intervalsIcu,
      statsStreams,
      params.tag,
      expectedReps,
    );
    if (fromIcu) {
      log.info({ segments: fromIcu.length }, "intervals.icu segments");
      return ensureWarmupFirst(fromIcu, activityId, t0);
    }
    log.info("intervals.icu breakdown unusable — trying laps/heuristics");
  }

  const shapeUnchanged = structureShapeMatches(initialResult?.structure, userSets);
  if (shapeUnchanged && laps.length > 0) {
    log.info("structure unchanged — attempting lap-derived segments");
    const fromLaps = buildSegmentsFromLaps(activityId, laps, userSets, statsStreams, params.tag);
    if (fromLaps) {
      const reps = workCount(fromLaps);
      if (declaredReps !== undefined && reps !== declaredReps) {
        log.info(
          { workCount: reps, declaredReps },
          "lap-derived work count contradicts declared shape — falling through",
        );
      } else {
        log.info({ segments: fromLaps.length }, "lap-derived segments");
        return ensureWarmupFirst(fromLaps, activityId, t0);
      }
    } else {
      log.info("lap-derivation failed — trying deterministic segmenter");
    }
  }

  // Deterministic segmenter (speed/HR + the known/inferred structure) for the
  // non-lap-matching path (indoor / dense / one-big-work-lap), where the LLM
  // used to invent rep counts and crush the warmup to 60s. Validated on real
  // workouts — see [[deterministic-interval-segmentation]]. A weak result
  // (confidence below threshold) falls through to the LLM rather than shipping
  // a bad split.
  const deterministic = buildSegmentsDeterministic(activityId, laps, userSets, statsStreams);
  if (deterministic && deterministic.confidence >= DETERMINISTIC_CONFIDENCE_THRESHOLD) {
    const reps = workCount(deterministic.segments);
    if (declaredReps !== undefined && reps !== declaredReps) {
      log.info(
        { workCount: reps, declaredReps },
        "deterministic work count contradicts declared shape — falling through to LLM",
      );
    } else {
      log.info(
        {
          segments: deterministic.segments.length,
          confidence: deterministic.confidence,
          mode: deterministic.mode,
        },
        "deterministic segments",
      );
      return ensureWarmupFirst(deterministic.segments, activityId, t0);
    }
  }
  if (deterministic) {
    log.info(
      { confidence: deterministic.confidence, mode: deterministic.mode },
      "deterministic low-confidence — falling back to LLM",
    );
  } else {
    log.info("deterministic failed — invoking segmentation LLM");
  }
  const segmentPlan = await invokeWithRateLimitRetry(() =>
    invokeCompleteActivityAnalysisAgent(
      streams,
      userNotes,
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
