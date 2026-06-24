import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities, type ProposedSegmentDraft } from "../../schema";
import { getProposedPaceForStructure, getProposedPaceFromLaps } from "../../services/pace_service";
import { generateCompleteIntervalSet, needCompleteAnalysis } from "../../services/utils";
import type { ExpandedIntervalSet } from "../../types/ExpandedIntervalSet";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable } from "../graph_state";
import { produceSegments } from "../segment_production";

export async function proposeSegments(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "proposeSegments", activityId: state.activityId });
  const { db, clerkUserId } = config.configurable as GraphConfigurable;

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

  // Build the per-rep set list ONCE, with proposed paces filled by the SAME logic
  // as the /proposed-pace view (analysis_controller.getProposedPace): lap-derived
  // when the outdoor activity has laps, else history. Keeping the two in lockstep
  // is the unification — the proposed SEGMENTS and the proposed PACES are one rep
  // list carrying identical paces, so they can't disagree in the editor.
  const structure = state.initialResult?.structure ?? [];
  let draftSets: ExpandedIntervalSet[] = structure.length
    ? generateCompleteIntervalSet(structure)
    : [];
  if (structure.length) {
    try {
      const fromLaps = state.laps?.length ? getProposedPaceFromLaps(state.laps, structure) : null;
      draftSets =
        fromLaps ?? (await getProposedPaceForStructure(db, state.userId, clerkUserId, structure));
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
