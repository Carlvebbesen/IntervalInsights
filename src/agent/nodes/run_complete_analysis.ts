import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities } from "../../schema";
import { INTERVAL_TRAINING_TYPES, isPowerSport } from "../../schema/enums";
import {
  boundariesMatchUserShape,
  mapBoundariesToSegments,
  toBoundaries,
} from "../../services/segment_mapping_service";
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
    !isPowerSport(state.activityType) &&
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
  const streams = state.streams;
  const statsStreams = streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  await db
    .update(activities)
    .set({ analysisStatus: "ongoing_completed", analysisStartedAt: new Date() })
    .where(eq(activities.id, state.activityId));

  const deriveFromUserShape = (reason: string) => {
    log.warn(reason);
    return produceSegments({
      activityId: state.activityId,
      statsStreams,
      streams,
      laps: state.laps,
      isIndoor: state.isIndoor,
      userSets: state.userSets,
      initialResult: state.initialResult,
      userNotes: state.userNotes,
      trainingType,
      intervalsIcuIntervals: state.intervalsIcuPrediction?.intervals ?? null,
      declaredReps:
        state.structureSource !== "model"
          ? state.userSets.reduce((n, s) => n + s.steps.length, 0) || undefined
          : undefined,
      log,
      tag: `[runCompleteAnalysis activity=${state.activityId}]`,
    });
  };

  const hasEdits = state.userEditedSegments.length > 0;
  const boundaries: SegmentBoundary[] = hasEdits
    ? state.userEditedSegments
    : toBoundaries(state.proposedSegments);

  if (boundaries.length === 0) {
    const fallback = await deriveFromUserShape(
      "no edited or proposed segments — falling back to inline produceSegments (legacy)",
    );
    log.info({ computedSegments: fallback.length }, "computed segments (legacy fallback)");
    return { computedSegments: fallback };
  }

  if (!hasEdits && !boundariesMatchUserShape(boundaries, state.userSets)) {
    const rederived = await deriveFromUserShape(
      "proposed boundaries disagree with user shape — re-deriving segments from user sets",
    );
    log.info(
      { computedSegments: rederived.length },
      "computed segments (re-derived, boundary/sets mismatch)",
    );
    return { computedSegments: rederived };
  }

  const computedSegments = mapBoundariesToSegments(
    statsStreams,
    boundaries,
    state.userSets,
    state.activityId,
    `[runCompleteAnalysis activity=${state.activityId}]`,
  );

  log.info(
    { computedSegments: computedSegments.length, fromEdits: hasEdits },
    "computed segments (deterministic mapping)",
  );
  return { computedSegments };
}
