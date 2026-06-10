import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import { findMatchingStructure } from "../../services/signature_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function validateSignature(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "validateSignature", activityId: state.activityId });
  if (state.computedSegments.length === 0) {
    log.info("no computedSegments — skipping signature check");
    return { signatureCheck: null };
  }
  const { db } = config.configurable as GraphConfigurable;

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("validateSignature called without a resolved trainingType");
  }

  const intervalsCount = state.computedSegments.filter((s) => s.type === "INTERVALS").length;
  log.info(
    { segments: state.computedSegments.length, intervalsTyped: intervalsCount },
    "validating",
  );
  if (intervalsCount === 0 && state.computedSegments.length > 0) {
    log.warn(
      'no INTERVALS-typed segments — signature will be empty and structure will be "Free Workout". Check the LLM output / prompt.',
    );
  }
  const check = await findMatchingStructure(db, state.computedSegments, trainingType, state.userId);
  log.info(
    {
      useExisting: check.useExisting,
      structureId: check.structureId ?? "new",
      signature: check.signature,
    },
    "signature check result",
  );
  return { signatureCheck: check };
}
