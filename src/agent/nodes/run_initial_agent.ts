import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities, type DraftAnalysisResult } from "../../schema";
import { lapsMatchIntervals, needCompleteAnalysis } from "../../services/utils";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { invokeActivityAnalysisAgent } from "../initial_analysis_agent";
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
    ),
  );

  if (!initialResult) {
    throw new Error("Initial analysis agent returned null");
  }

  const lapsMatchStructure =
    !state.isIndoor &&
    needCompleteAnalysis(initialResult.training_type) &&
    lapsMatchIntervals(state.laps, initialResult);

  const draft: DraftAnalysisResult = {
    ...initialResult,
    lapsMatchStructure,
    intervalsIcuPrediction: state.intervalsIcuPrediction,
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

  const structureSummary = (initialResult.structure ?? [])
    .map(
      (s) =>
        `${s.set_reps}×[${s.steps.map((st) => `${st.reps}×${st.work_value}${st.work_type === "DISTANCE" ? "m" : "s"}`).join("+")}]`,
    )
    .join(" | ");
  log.info(
    {
      trainingType: initialResult.training_type,
      confidence: Number(initialResult.confidence_score.toFixed(2)),
      lapsMatchStructure,
      structure: structureSummary || null,
    },
    "initialResult ready",
  );

  return { initialResult, lapsMatchStructure };
}
