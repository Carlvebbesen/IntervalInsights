import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { activities, type DraftAnalysisResult } from "../../schema";
import { lapsMatchIntervals, needCompleteAnalysis } from "../../services.ts/utils";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { invokeActivityAnalysisAgent } from "../initial_analysis_agent";
import { ANALYSIS_VERSION, invokeWithRateLimitRetry } from "../model";

export async function runInitialAgent(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  const tag = `[runInitialAgent activity=${state.activityId}]`;

  if (!state.streams) {
    throw new Error(`${tag} called without streams in state`);
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

  console.log(
    `${tag} initialResult.training_type=${initialResult.training_type} lapsMatchStructure=${lapsMatchStructure}`,
  );

  return { initialResult, lapsMatchStructure };
}
