import type { RunnableConfig } from "@langchain/core/runnables";
import { findMatchingStructure } from "../../services.ts/signature_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function validateSignature(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const tag = `[validateSignature activity=${state.activityId}]`;
  if (state.computedSegments.length === 0) {
    console.log(`${tag} no computedSegments — skipping signature check`);
    return { signatureCheck: null };
  }
  const { db } = config.configurable as GraphConfigurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("validateSignature called without a resolved trainingType");
  }

  const intervalsCount = state.computedSegments.filter((s) => s.type === "INTERVALS").length;
  console.log(
    `${tag} validating ${state.computedSegments.length} segments (${intervalsCount} INTERVALS-typed, segmentsFromLaps=${state.segmentsFromLaps})`,
  );
  if (intervalsCount === 0 && state.computedSegments.length > 0) {
    console.warn(
      `${tag} WARNING: no INTERVALS-typed segments — signature will be empty and structure will be "Free Workout". Check the LLM output / prompt.`,
    );
  }
  const check = await findMatchingStructure(db, state.computedSegments, trainingType, state.userId);
  console.log(
    `${tag} result: useExisting=${check.useExisting} structureId=${check.structureId ?? "new"} signature="${check.signature}"`,
  );
  return { signatureCheck: check };
}
