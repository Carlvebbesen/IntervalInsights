import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities } from "../../schema";
import { INTERVAL_TRAINING_TYPES } from "../../schema/enums";
import { mapBoundariesToSegments, toBoundaries } from "../../services/segment_mapping_service";
import { needCompleteAnalysis } from "../../services/utils";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable, SegmentBoundary } from "../graph_state";
import { produceSegments } from "../segment_production";

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
    log.info({ trainingType }, "trainingType skips segment breakdown");
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

  if (!state.streams?.time || !state.streams?.distance) {
    throw new Error(
      `[runCompleteAnalysis activity=${state.activityId}] streams missing time or distance — cannot compute segment stats`,
    );
  }
  const statsStreams = state.streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_completed", analysisStartedAt: new Date() })
    .where(eq(activities.id, state.activityId));

  const boundaries: SegmentBoundary[] = state.userEditedSegments.length
    ? state.userEditedSegments
    : toBoundaries(state.proposedSegments);

  if (boundaries.length === 0) {
    log.warn("no edited or proposed segments — falling back to inline produceSegments (legacy)");
    const fallback = await produceSegments({
      activityId: state.activityId,
      statsStreams,
      streams: state.streams,
      laps: state.laps,
      isIndoor: state.isIndoor,
      userSets: state.userSets,
      initialResult: state.initialResult,
      userNotes: state.userNotes,
      trainingType,
      intervalsIcuIntervals: state.intervalsIcuPrediction?.intervals ?? null,
      log,
      tag: `[runCompleteAnalysis activity=${state.activityId}]`,
    });
    log.info({ computedSegments: fallback.length }, "computed segments (legacy fallback)");
    return { computedSegments: fallback };
  }

  const computedSegments = mapBoundariesToSegments(
    statsStreams,
    boundaries,
    state.userSets,
    state.activityId,
    `[runCompleteAnalysis activity=${state.activityId}]`,
  );

  log.info(
    { computedSegments: computedSegments.length, fromEdits: state.userEditedSegments.length > 0 },
    "computed segments (deterministic mapping)",
  );
  return { computedSegments };
}
