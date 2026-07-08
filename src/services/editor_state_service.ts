import type { z } from "zod";
import type { WorkoutAnalysisOutput, workoutSet } from "../agent/initial_analysis_agent";
import { produceSegments } from "../agent/segment_production";
import { getProposedPace } from "../controllers/analysis_controller";
import { AppError } from "../error";
import type { Logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import * as activityRepo from "../repositories/activity_repository";
import type { ProposedSegmentDraft, TrainingType } from "../schema";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import { getLaps, getStreamSet } from "./activity_source_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { intervalsApiService } from "./intervals_api_service";
import { extractIntervalsList } from "./intervals_mappers";
import { stravaApiService } from "./strava_api_service";

type Db = IGlobalBindings["db"];

type WorkoutSet = z.infer<typeof workoutSet>;

/**
 * Re-segment an activity for a USER-PROVIDED structure (e.g. after the user
 * re-describes their intervals via parse-from-text) and return the unified per-rep
 * list — boundaries (from the same `produceSegments` cascade the analyze graph uses)
 * PLUS proposed paces (same logic as `/proposed-pace`). Keeps the segment view and
 * the proposed structure in sync after a re-describe. Read-only; persists nothing.
 */
export async function previewSegments(
  db: Db,
  userId: string,
  activityId: number,
  sets: ExpandedIntervalSet[],
  trainingType: TrainingType,
  logger: Logger,
): Promise<ProposedSegmentDraft[]> {
  const log = logger.child({ fn: "previewSegments", activityId });
  if (!sets || sets.length === 0) return [];

  const activity = await activityRepo.requireOwnedActivity(db, userId, activityId);

  const streamSet = await getStreamSet(db, userId, activityId);
  const time = streamSet.time;
  const distance = streamSet.distance;
  if (!time?.data?.length || !distance?.data?.length) {
    throw new AppError(400, "Activity streams missing time/distance");
  }
  const statsStreams = { time, distance, heartrate: streamSet.heartrate };

  const laps = await getLaps(db, userId, activityId);

  let intervalsIcuIntervals: IIntervalsInterval[] | null = null;
  if (activity.intervalsIcuId) {
    try {
      const token = await getIntervalsAccessToken(userId);
      intervalsIcuIntervals = extractIntervalsList(
        await intervalsApiService.getActivityIntervals(token, activity.intervalsIcuId),
      );
    } catch (err) {
      log.warn({ err }, "intervals.icu intervals fetch failed — proceeding without");
    }
  }

  // The supplied sets ARE the source of truth — the single rep-list that drives
  // both the segment list and the pace view. Their paces (already proposed by
  // /proposed-pace or /parse-intervals) flow straight through to the segments;
  // we never recompute, so the two views cannot diverge. Derive a 1-rep-per-step
  // structure so the cascade's shape/rep-count rungs see the same shape as userSets.
  const structure: WorkoutAnalysisOutput["structure"] = sets.map((set) => ({
    set_reps: 1,
    set_recovery: set.set_recovery ?? null,
    steps: set.steps.map((step) => ({
      reps: 1,
      work_type: step.work_type,
      work_value: step.work_value,
      recovery_type: step.recovery_type ?? null,
      recovery_value: step.recovery_value ?? null,
    })),
  }));

  const initialResult: WorkoutAnalysisOutput = {
    classification_reasoning: "preview",
    training_type: trainingType,
    confidence_score: 1,
    structure,
  };

  const segments = await produceSegments({
    activityId,
    statsStreams,
    streams: streamSet,
    laps,
    isIndoor: activity.indoor ?? false,
    userSets: sets,
    initialResult,
    userNotes: "",
    trainingType,
    intervalsIcuIntervals,
    log,
    tag: `[previewSegments activity=${activityId}]`,
  });

  return segments.map((s) => ({
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
}

type EditorStreams = { time: number[]; heartrate: number[] | null; velocity: number[] };

async function loadEditorStreams(
  db: Db,
  userId: string,
  accessToken: string,
  stravaActivityId: number,
): Promise<EditorStreams> {
  const consent = await userHasHeartRateConsent(db, userId);
  const keys = ["time", "velocity_smooth", "distance"] as const;
  const streamKeys = consent ? ([...keys, "heartrate"] as const) : keys;
  const streams = await stravaApiService.getActivityStreams(accessToken, stravaActivityId, [
    ...streamKeys,
  ]);
  return {
    time: streams?.time?.data ?? [],
    heartrate: consent ? (streams?.heartrate?.data ?? null) : null,
    velocity: streams?.velocity_smooth?.data ?? [],
  };
}

/**
 * Hydrate BOTH editor views from one source of truth in a single call. The paced
 * rep-list (`sets`) drives the derived per-rep `segments`, so the proposed-pace view
 * and the segment editor cannot diverge. Two modes via the input:
 *   - `structure` (WorkoutSet[]) → initial load: compute proposed paces (lap-preferred,
 *     same logic as /proposed-pace), then derive segments from them.
 *   - `sets` (paced ExpandedIntervalSet[]) → re-derive after a STRUCTURAL edit
 *     (add/remove/delete a rep) or parse-from-text: the supplied paces flow verbatim.
 * `streams` is returned for the chart unless `includeStreams === false`. Read-only.
 */
export async function getEditorState(
  db: Db,
  userId: string,
  accessToken: string | undefined,
  activityId: number,
  input: {
    structure?: WorkoutSet[];
    sets?: ExpandedIntervalSet[];
    trainingType: TrainingType;
    includeStreams?: boolean;
  },
  logger: Logger,
): Promise<{
  sets: ExpandedIntervalSet[];
  segments: ProposedSegmentDraft[];
  streams: EditorStreams | null;
}> {
  const log = logger.child({ fn: "getEditorState", activityId });

  const sets =
    input.sets ??
    (await getProposedPace(db, userId, accessToken, input.structure ?? [], activityId, log));

  const segments = await previewSegments(db, userId, activityId, sets, input.trainingType, log);

  let streams: EditorStreams | null = null;
  if (input.includeStreams !== false && accessToken) {
    const activity = await activityRepo.findByIdForUser(db, userId, activityId);
    if (activity?.stravaActivityId != null) {
      streams = await loadEditorStreams(db, userId, accessToken, activity.stravaActivityId);
    }
  }

  return { sets, segments, streams };
}
