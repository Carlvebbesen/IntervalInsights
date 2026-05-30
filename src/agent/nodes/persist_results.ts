import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import type { DraftAnalysisResult } from "../../schema/activities";
import {
  completeWithoutSegments,
  persistSegmentsAndStructure,
} from "../../services/signature_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function persistResults(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "persistResults", activityId: state.activityId });

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("persistResults called without a resolved trainingType");
  }

  if (state.computedSegments.length === 0 || !state.signatureCheck) {
    await completeWithoutSegments(db, {
      activityId: state.activityId,
      trainingType,
      userNotes: state.userNotes,
      feeling: state.feeling,
    });
    log.info("no segments — wrote status=completed");
    return {};
  }

  let draftOverride: DraftAnalysisResult | null = null;
  if (state.segmentsFromLaps && state.initialResult) {
    draftOverride = {
      ...state.initialResult,
      acceptedSets: state.userSets,
      segmentsFromLaps: true,
    };
    log.info(
      { acceptedSets: state.userSets.length },
      "preparing draftOverride: segmentsFromLaps=true (segments will NOT be persisted)",
    );
  } else {
    log.info("normal LLM path: persisting segments to DB, draftAnalysisResult will be nulled");
  }

  await persistSegmentsAndStructure(db, {
    activityId: state.activityId,
    userId: state.userId,
    trainingType,
    segments: state.computedSegments,
    check: state.signatureCheck,
    userNotes: state.userNotes,
    feeling: state.feeling,
    persistSegments: !state.segmentsFromLaps,
    draftOverride,
  });
  log.info(
    {
      segments: state.computedSegments.length,
      segmentsFromLaps: state.segmentsFromLaps,
      action: state.segmentsFromLaps ? "skipped" : "wrote",
    },
    "persisted segments, status=completed",
  );
  return {};
}
