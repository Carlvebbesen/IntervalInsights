import type { RunnableConfig } from "@langchain/core/runnables";
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

  await persistSegmentsAndStructure(db, {
    activityId: state.activityId,
    userId: state.userId,
    trainingType,
    segments: state.computedSegments,
    check: state.signatureCheck,
    userNotes: state.userNotes,
    feeling: state.feeling,
  });
  console.log(`${tag} wrote ${state.computedSegments.length} segments, status=completed`);
  return {};
}
