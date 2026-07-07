import type { z } from "zod";
import type { SegmentBoundary } from "../agent/graph_state";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { invokeParseIntervalsAgent } from "../agent/parse_intervals_agent";
import { runInBackground } from "../background";
import { AppError } from "../error";
import type { Logger } from "../logger";
import { recordAnalysisRun, recordTrainingTypeChange } from "../otel";
import * as activityRepo from "../repositories/activity_repository";
import type { AnalysisStatus, TrainingType } from "../schema";
import type { PendingActivitySchema } from "../schemas/api_schemas";
import { ResumeValidationError, resumeAnalysis, startAnalysis } from "../services/analysis_service";
import { createGearSuggester } from "../services/gear_suggestion_service";
import { getProposedPaceForStructure, getProposedPaceFromLaps } from "../services/pace_service";
import { requeueStaleActivities } from "../services/requeue_service";
import { stravaApiService } from "../services/strava_api_service";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];
type WorkoutSet = z.infer<typeof workoutSet>;

const PENDING_STATUSES: readonly AnalysisStatus[] = ["initial", "pending", "error"];

/** Re-queue stale rows (if a token is present), then return the user's pending activities. */
export async function getPending(
  db: Db,
  userId: string,
  accessToken: string | undefined,
): Promise<z.infer<typeof PendingActivitySchema>[]> {
  if (accessToken) {
    await requeueStaleActivities(db, userId, accessToken);
  }
  const rows = await activityRepo.listPending(db, userId, PENDING_STATUSES);

  const suggestFor = await createGearSuggester(db, userId);
  return Promise.all(
    rows.map(async (r) => {
      const { suggestedGearId, gearSuggestions } = await suggestFor({
        sportType: r.sportType,
        trainingType: r.trainingType ?? r.draftAnalysisResult?.training_type ?? null,
        localGearId: r.localGearId,
        gearUpdatedFromStrava: r.gearUpdatedFromStrava,
        intervalStructureId: r.intervalStructureId,
      });
      return {
        ...r,
        startDateLocal: r.startDateLocal.toISOString(),
        suggestedGearId,
        gearSuggestions,
      };
    }),
  );
}

export async function startActivityAnalysis(
  db: Db,
  accessToken: string | undefined,
  activityId: number,
  userId: string,
  force = false,
): Promise<{ success: true }> {
  if (!accessToken) {
    throw new AppError(400, "Access token missing");
  }
  const owned = await activityRepo.requireOwnedActivity(db, userId, activityId);
  // Fire-and-forget — the pipeline runs in the background. `force` re-runs an
  // already-analysed / sync-imported activity (overwrites its draft + segments).
  // The Strava id comes from the owned row, never the request body: a mismatched
  // client value would write another activity's streams onto this row.
  recordAnalysisRun({ phase: "start", trigger: force ? "reanalyze" : "manual" });
  runInBackground(
    "analysis.start",
    () => startAnalysis(db, accessToken, activityId, owned.stravaActivityId, userId, force),
    { attributes: { "activity.id": activityId, "user.id": userId } },
  );
  return { success: true };
}

export interface ResumeAnalysisInput {
  activityId: number;
  notes?: string;
  sets?: ExpandedIntervalSet[];
  trainingType?: TrainingType | null;
  feeling?: number | null;
  editedSegments?: SegmentBoundary[];
}

export async function resumeActivityAnalysis(
  db: Db,
  accessToken: string | undefined,
  userId: string,
  input: ResumeAnalysisInput,
  logger: Logger,
): Promise<{ success: true }> {
  const { activityId, notes, sets, trainingType, feeling, editedSegments } = input;
  logger.info(
    {
      activityId,
      setCount: sets?.length ?? 0,
      stepCount: sets?.reduce((s, set) => s + set.steps.length, 0) ?? 0,
      notesLen: notes?.length ?? 0,
      trainingType,
      feeling,
      editedSegments: editedSegments?.length ?? 0,
    },
    "resume-analysis payload",
  );
  if (!accessToken) {
    throw new AppError(400, "Access token missing");
  }
  await activityRepo.requireOwnedActivity(db, userId, activityId);
  try {
    await resumeAnalysis(
      db,
      accessToken,
      activityId,
      notes ?? "",
      sets ?? [],
      trainingType ?? null,
      feeling ?? null,
      editedSegments ?? [],
    );
  } catch (err) {
    if (err instanceof ResumeValidationError) {
      logger.info({ err: err.message }, "resume-analysis validation failed");
      throw new AppError(400, err.message);
    }
    throw err;
  }
  recordAnalysisRun({ phase: "resume", trigger: "manual" });
  if (trainingType) recordTrainingTypeChange({ trainingType, via: "resume" });
  return { success: true };
}

export async function getProposedPace(
  db: Db,
  userId: string,
  clerkUserId: string,
  accessToken: string | undefined,
  structure: WorkoutSet[],
  activityId: number | undefined,
  logger: Logger,
): Promise<ExpandedIntervalSet[]> {
  const log = logger.child({ route: "proposed-pace", activityId });
  log.info(
    { structureSets: structure?.length ?? 0, hasAccessToken: !!accessToken },
    "proposed-pace request",
  );
  if (!structure || structure.length === 0) {
    log.info("empty structure — returning []");
    return [];
  }

  try {
    if (activityId) {
      const activity = await activityRepo.findPaceContext(db, userId, activityId);
      log.info(
        { found: !!activity, indoor: activity?.indoor, stravaId: activity?.stravaActivityId },
        "activity lookup",
      );
      if (activity && !activity.indoor && accessToken && activity.stravaActivityId != null) {
        const stravaActivityId = activity.stravaActivityId;
        try {
          const laps = await stravaApiService.getActivityLaps(accessToken, stravaActivityId);
          log.info({ lapCount: laps.length }, "fetched laps from Strava");
          const fromLaps = getProposedPaceFromLaps(laps, structure);
          if (fromLaps) {
            log.info("returning pace from laps");
            return fromLaps;
          }
          log.info("lap-derivation returned null — falling back to history");
        } catch (lapErr) {
          log.error({ err: lapErr }, "Strava laps fetch failed — falling back to history");
        }
      } else {
        log.info(
          { indoor: activity?.indoor, hasActivity: !!activity, hasToken: !!accessToken },
          "skipping lap-derivation — using history",
        );
      }
    } else {
      log.info("no activityId provided — using history");
    }
    const proposedPaces = await getProposedPaceForStructure(db, userId, clerkUserId, structure);
    log.info({ sets: proposedPaces.length }, "returning pace from history");
    return proposedPaces;
  } catch (err) {
    log.error({ err }, "Error calculating proposed pace");
    throw new AppError(500, "Failed to calculate pace");
  }
}

export async function parseIntervals(
  db: Db,
  userId: string,
  clerkUserId: string,
  text: string,
  trainingType: TrainingType | null,
  logger: Logger,
): Promise<ExpandedIntervalSet[]> {
  try {
    const parsed = await invokeParseIntervalsAgent(text, trainingType);
    if (!parsed || parsed.sets.length === 0) {
      return [];
    }
    return getProposedPaceForStructure(db, userId, clerkUserId, parsed.sets);
  } catch (err) {
    logger.error({ err }, "Error parsing intervals");
    throw new AppError(500, "Failed to parse intervals");
  }
}
