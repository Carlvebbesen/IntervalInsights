import type { RunnableConfig } from "@langchain/core/runnables";
import type { DraftAnalysisResult } from "../../schema/activities";
import {
  completeWithoutSegments,
  persistSegmentsAndStructure,
} from "../../services.ts/signature_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function persistResults(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  const tag = `[persistResults activity=${state.activityId}]`;

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
    console.log(`${tag} no segments — wrote status=completed`);
    return {};
  }

  let draftOverride: DraftAnalysisResult | null = null;
  if (state.segmentsFromLaps && state.initialResult) {
    draftOverride = {
      ...state.initialResult,
      acceptedSets: state.userSets,
      segmentsFromLaps: true,
    };
    console.log(
      `${tag} preparing draftOverride: acceptedSets=${state.userSets.length} segmentsFromLaps=true (segments will NOT be persisted)`,
    );
  } else {
    console.log(
      `${tag} normal LLM path: persisting segments to DB, draftAnalysisResult will be nulled`,
    );
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
  console.log(
    `${tag} ${state.segmentsFromLaps ? "skipped" : "wrote"} ${state.computedSegments.length} segments (segmentsFromLaps=${state.segmentsFromLaps}), status=completed`,
  );
  return {};
}
