import type { RunnableConfig } from "@langchain/core/runnables";
import { findMatchingStructure } from "../../services.ts/signature_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function validateSignature(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  if (state.computedSegments.length === 0) {
    return { signatureCheck: null };
  }
  const { db } = config.configurable as GraphConfigurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("validateSignature called without a resolved trainingType");
  }

  const check = await findMatchingStructure(db, state.computedSegments, trainingType, state.userId);
  return { signatureCheck: check };
}
