import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities, type ProposedSegmentDraft } from "../../schema";
import { generateCompleteIntervalSet, needCompleteAnalysis } from "../../services/utils";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { produceSegments } from "../segment_production";

export async function proposeSegments(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "proposeSegments", activityId: state.activityId });
  const { db } = config.configurable as GraphConfigurable;

  const trainingType = state.initialResult?.training_type;
  if (!trainingType || !needCompleteAnalysis(trainingType)) {
    log.info({ trainingType }, "non-interval type — no segment proposal");
    return { proposedSegments: [] };
  }

  if (!state.streams?.time || !state.streams?.distance) {
    log.warn("streams missing time/distance — skipping segment proposal");
    return { proposedSegments: [] };
  }
  const statsStreams = state.streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  const draftSets = state.initialResult?.structure?.length
    ? generateCompleteIntervalSet(state.initialResult.structure)
    : [];

  const proposedSegments = await produceSegments({
    activityId: state.activityId,
    statsStreams,
    streams: state.streams,
    laps: state.laps,
    isIndoor: state.isIndoor,
    userSets: draftSets,
    initialResult: state.initialResult,
    userNotes: "",
    trainingType,
    intervalsIcuIntervals: state.intervalsIcuPrediction?.intervals ?? null,
    log,
    tag: `[proposeSegments activity=${state.activityId}]`,
  });

  const slim: ProposedSegmentDraft[] = proposedSegments.map((s) => ({
    segmentIndex: s.segmentIndex,
    setGroupIndex: s.setGroupIndex,
    type: s.type,
    timeSeriesEndTime: s.timeSeriesEndTime,
    actualDistance: s.actualDistance,
    actualDuration: s.actualDuration,
    avgHeartRate: s.avgHeartRate,
    targetType: s.targetType,
    targetValue: s.targetValue,
    targetPace: s.targetPace,
  }));

  const existing = await db.query.activities.findFirst({
    where: eq(activities.id, state.activityId),
    columns: { draftAnalysisResult: true },
  });
  if (existing?.draftAnalysisResult) {
    await db
      .update(activities)
      .set({ draftAnalysisResult: { ...existing.draftAnalysisResult, proposedSegments: slim } })
      .where(eq(activities.id, state.activityId));
  }

  log.info({ proposedSegments: proposedSegments.length }, "segment proposal ready");
  return { proposedSegments };
}
