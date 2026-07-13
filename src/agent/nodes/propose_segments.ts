import type { RunnableConfig } from "@langchain/core/runnables";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "../../logger";
import { activities, isPowerSport, type ProposedSegmentDraft } from "../../schema";
import { getProposedPaceForStructure, getProposedPaceFromLaps } from "../../services/pace_service";
import { generateCompleteIntervalSet, needCompleteAnalysis } from "../../services/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { countStructureReps, produceSegments } from "../segment_production";

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

  const structure = state.initialResult?.structure ?? [];
  let draftSets: ExpandedIntervalSet[] = structure.length
    ? generateCompleteIntervalSet(structure)
    : [];
  if (structure.length && !isPowerSport(state.activityType)) {
    try {
      const fromLaps = state.laps?.length ? getProposedPaceFromLaps(state.laps, structure) : null;
      draftSets = fromLaps ?? (await getProposedPaceForStructure(db, state.userId, structure));
    } catch (err) {
      log.warn({ err }, "pace proposal failed — proposed segments will carry null target paces");
    }
  }

  const proposedSegments = await produceSegments({
    activityId: state.activityId,
    statsStreams,
    streams: state.streams,
    laps: state.laps,
    isIndoor: state.isIndoor,
    userSets: draftSets,
    initialResult: state.initialResult,
    trainingType,
    intervalsIcuIntervals: state.intervalsIcuPrediction?.intervals ?? null,
    declaredReps:
      state.structureSource !== "model"
        ? countStructureReps(state.initialResult?.structure)
        : undefined,
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

  await db
    .update(activities)
    .set({
      draftAnalysisResult: sql`(${activities.draftAnalysisResult}::jsonb || ${JSON.stringify({ proposedSegments: slim })}::jsonb)::json`,
    })
    .where(and(eq(activities.id, state.activityId), isNotNull(activities.draftAnalysisResult)));

  log.info({ proposedSegments: proposedSegments.length }, "segment proposal ready");
  return { proposedSegments };
}
