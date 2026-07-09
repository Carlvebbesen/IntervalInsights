import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities, type DraftAnalysisResult } from "../../schema";
import {
  extractDeclaredStructure,
  reconcileStructureTowardDeclared,
} from "../../services/text_intent_service";
import { lapsMatchIntervals, needCompleteAnalysis } from "../../services/utils";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { invokeActivityAnalysisAgent, type WorkoutAnalysisOutput } from "../initial_analysis_agent";
import { ANALYSIS_VERSION, invokeWithRateLimitRetry } from "../model";

export async function runInitialAgent(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "runInitialAgent", activityId: state.activityId });

  if (!state.streams) {
    throw new Error(
      `[runInitialAgent activity=${state.activityId}] called without streams in state`,
    );
  }

  const initialResult = await invokeWithRateLimitRetry(() =>
    invokeActivityAnalysisAgent(
      state.streams as NonNullable<typeof state.streams>,
      state.activityTitle,
      state.activityDescription || "-",
      state.totalElevationGain,
      state.activityType,
      state.intervalsIcuPrediction,
      state.laps,
    ),
  );

  if (!initialResult) {
    throw new Error("Initial analysis agent returned null");
  }

  // Text authority: when the title/description explicitly declares a structure,
  // it wins on SHAPE over the model's stream-derived reading. Generic titles pass
  // the deterministic prefilter and cost zero extra LLM calls.
  const declaredStructure = await extractDeclaredStructure(
    [state.activityTitle, state.activityDescription],
    initialResult.training_type,
  );
  let finalResult = initialResult;
  let structureSource: "text" | "model" = "model";
  if (declaredStructure) {
    const { result, changed } = reconcileStructureTowardDeclared(initialResult, declaredStructure);
    finalResult = result;
    structureSource = "text";
    if (changed) {
      log.info(
        {
          structureSource: "text",
          modelReps: countReps(initialResult.structure),
          declaredReps: countReps(result.structure),
          modelType: initialResult.training_type,
          declaredType: result.training_type,
        },
        "structure reconciled toward declared text",
      );
    }
  }

  const lapsMatchStructure =
    !state.isIndoor &&
    needCompleteAnalysis(finalResult.training_type) &&
    lapsMatchIntervals(state.laps, finalResult);

  const draft: DraftAnalysisResult = {
    ...finalResult,
    lapsMatchStructure,
    intervalsIcuPrediction: state.intervalsIcuPrediction,
    structureSource,
    declaredStructure: declaredStructure ?? null,
  };

  await db
    .update(activities)
    .set({
      analyzedAt: new Date(),
      analysisStatus: "initial",
      draftAnalysisResult: draft,
      analysisVersion: ANALYSIS_VERSION,
    })
    .where(eq(activities.id, state.activityId));

  const structureSummary = (finalResult.structure ?? [])
    .map(
      (s) =>
        `${s.set_reps}×[${s.steps.map((st) => `${st.reps}×${st.work_value}${st.work_type === "DISTANCE" ? "m" : "s"}`).join("+")}]`,
    )
    .join(" | ");
  log.info(
    {
      trainingType: finalResult.training_type,
      confidence: Number(finalResult.confidence_score.toFixed(2)),
      lapsMatchStructure,
      structureSource,
      structure: structureSummary || null,
    },
    "initialResult ready",
  );

  return { initialResult: finalResult, lapsMatchStructure, structureSource };
}

/** Total work reps implied by a structure (set_reps × Σ step.reps), for logging. */
function countReps(structure: WorkoutAnalysisOutput["structure"]): number {
  if (!structure) return 0;
  let n = 0;
  for (const set of structure) {
    n += (set.set_reps ?? 1) * set.steps.reduce((s, st) => s + (st.reps ?? 1), 0);
  }
  return n;
}
