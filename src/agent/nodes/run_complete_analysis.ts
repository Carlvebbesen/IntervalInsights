import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities } from "../../schema";
import { INTERVAL_TRAINING_TYPES } from "../../schema/enums";
import {
  buildSegmentsFromLaps,
  structureShapeMatches,
} from "../../services.ts/lap_derivation_service";
import {
  calculateSegmentStats,
  needCompleteAnalysis,
  parsePaceStringToMetersPerSecond,
} from "../../services.ts/utils";
import type { StreamSet } from "../../types/strava/IStream";
import { invokeCompleteActivityAnalysisAgent } from "../full_analysis_agent";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { invokeWithRateLimitRetry } from "../model";

export async function runCompleteAnalysis(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "runCompleteAnalysis", activityId: state.activityId });
  const { db } = config.configurable as GraphConfigurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("runCompleteAnalysis called without a resolved trainingType");
  }

  if (!needCompleteAnalysis(trainingType)) {
    log.info({ trainingType }, "trainingType skips LLM segment breakdown");
    return { computedSegments: [] };
  }

  if (
    state.isIndoor &&
    (INTERVAL_TRAINING_TYPES as readonly string[]).includes(trainingType) &&
    state.userSets.some((set) =>
      set.steps.some((step) => step.target_pace == null || Number(step.target_pace) === 0),
    )
  ) {
    log.warn(
      "indoor + interval training type but at least one work step has no target_pace — GPS pace from streams will be unreliable. Persisting whatever the user provided.",
    );
  }

  if (!state.streams) {
    throw new Error(
      `[runCompleteAnalysis activity=${state.activityId}] called without streams in state`,
    );
  }

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_completed" })
    .where(eq(activities.id, state.activityId));

  if (!state.streams.time || !state.streams.distance) {
    throw new Error(
      `[runCompleteAnalysis activity=${state.activityId}] streams missing time or distance — cannot compute segment stats`,
    );
  }
  const statsStreams = state.streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  const shapeUnchanged = structureShapeMatches(state.initialResult?.structure, state.userSets);
  if (shapeUnchanged && !state.isIndoor && state.laps.length > 0) {
    log.info("structure unchanged + outdoor — attempting lap-derived segments");
    const fromLaps = buildSegmentsFromLaps(
      state.activityId,
      state.laps,
      state.userSets,
      statsStreams,
      `[runCompleteAnalysis activity=${state.activityId}]`,
    );
    if (fromLaps) {
      log.info(
        { segments: fromLaps.length },
        "lap-derived segments — skipping LLM and segment persistence",
      );
      return { computedSegments: fromLaps, segmentsFromLaps: true };
    }
    log.info("lap-derivation failed — falling back to LLM");
  } else {
    log.info(
      { shapeUnchanged, indoor: state.isIndoor, laps: state.laps.length },
      "skipping lap-derived path",
    );
  }

  log.info("invoking complete analysis LLM");
  const segmentPlan = await invokeWithRateLimitRetry(() =>
    invokeCompleteActivityAnalysisAgent(
      state.streams as NonNullable<typeof state.streams>,
      state.userNotes,
      trainingType,
      state.laps,
      state.initialResult,
      state.userSets,
    ),
  );

  if (!segmentPlan) {
    throw new Error("Complete analysis agent returned null");
  }
  log.info({ rawSegments: segmentPlan.segments.length }, "LLM returned segments");

  let segmentIndexCounter = 0;
  let droppedByStats = 0;
  const computedSegments = segmentPlan.segments
    .map((seg) => {
      const stats = calculateSegmentStats(statsStreams, seg.start_time, seg.end_time);
      if (!stats) {
        droppedByStats += 1;
        return null;
      }
      return {
        activityId: state.activityId,
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
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  log.info({ computedSegments: computedSegments.length, droppedByStats }, "computed segments");
  return { computedSegments };
}
