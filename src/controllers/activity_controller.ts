import type { z } from "zod";
import { runInBackground } from "../background";
import { type ActivityDto, toActivityDto, toActivityListItemDto } from "../dtos/activity_dto";
import { toActivityEventDto } from "../dtos/event_dto";
import { toGearSummaryDto } from "../dtos/gear_dto";
import { AppError } from "../error";
import type { Logger } from "../logger";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { recordTrainingTypeChange } from "../otel";
import * as activityRepo from "../repositories/activity_repository";
import * as eventRepo from "../repositories/event_repository";
import * as gearRepo from "../repositories/gear_repository";
import type { InsertActivity, TrainingType } from "../schema";
import type { ActivityListResponseSchema } from "../schemas/api_schemas";
import { linkActivityGearOnIngest } from "../services/gear_strava_service";
import { userHasHeartRateConsent } from "../services/heart_rate_consent_service";
import { enrichActivityFromIntervalsIcu } from "../services/intervals_link_service";
import { getSegmentsForActivity } from "../services/lap_derivation_service";
import type { IGlobalBindings } from "../types/IRouters";

export {
  getLaps,
  getSplits,
  getStreamSet,
  getStreams,
} from "../services/activity_source_service";
export { getEditorState, previewSegments } from "../services/editor_state_service";
export { editSegments } from "../services/segment_edit_service";

type Db = IGlobalBindings["db"];

type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;

export async function listActivities(
  db: Db,
  userId: string,
  filters: activityRepo.ActivityListFilters,
): Promise<ActivityListResponse> {
  const rows = await activityRepo.listForUser(db, userId, filters);
  return {
    data: rows.map(toActivityListItemDto),
    meta: {
      page: filters.page,
      pageSize: activityRepo.PAGE_SIZE,
      filterApplied: {
        search: filters.search,
        trainingType: filters.trainingType,
        distance: filters.distance,
        intervalStructureId: filters.intervalStructureId,
        sportTypes: filters.sportTypes,
        signatures: filters.signatures,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        eventTypes: filters.eventTypes,
        eventIds: filters.eventIds,
      },
    },
  };
}

async function resolveGearSummary(db: Db, userId: string, localGearId: number | null) {
  if (localGearId == null) return null;
  const summary = (await gearRepo.findSummariesByIds(db, userId, [localGearId])).get(localGearId);
  return summary ? toGearSummaryDto(summary) : null;
}

async function resolveActivityGearId(
  db: Db,
  userId: string,
  activity: {
    id: number;
    localGearId: number | null;
    gearId: string | null;
    sportType: string;
    startDateLocal: Date;
  },
  logger: Logger,
): Promise<number | null> {
  if (activity.localGearId != null) return activity.localGearId;
  const stravaGearId = activity.gearId;
  if (!stravaGearId) return null;

  const existing = await gearRepo.findByStravaGearId(db, userId, stravaGearId);
  if (existing) {
    await gearRepo.assignActivityToGear(db, userId, activity.id, existing.id);
    return existing.id;
  }

  try {
    const { access_token } = await getStravaAccessTokens(userId);
    await linkActivityGearOnIngest(db, userId, access_token, activity.id, {
      stravaGearId,
      sportType: activity.sportType,
      startDateLocal: activity.startDateLocal,
    });
    return (await gearRepo.findByStravaGearId(db, userId, stravaGearId))?.id ?? null;
  } catch (err) {
    logger.warn(
      { err, userId, activityId: activity.id, stravaGearId },
      "could not lazy-link Strava gear on detail view",
    );
    return null;
  }
}

export async function getActivityDetail(
  db: Db,
  userId: string,
  activityId: number,
  logger: Logger,
): Promise<ActivityDto> {
  const [activity, relatedEvents] = await Promise.all([
    activityRepo.requireOwnedActivity(db, userId, activityId),
    eventRepo.listForActivity(db, activityId),
  ]);

  if (!activity.intervalsIcuId || !activity.intervalsIcuEnrichedAt) {
    runInBackground(
      "intervals.enrichActivity",
      () => enrichActivityFromIntervalsIcu({ db }, { id: userId }, activityId),
      { attributes: { "activity.id": activityId, "user.id": userId }, logger },
    );
  }

  const localGearId = await resolveActivityGearId(db, userId, activity, logger);
  activity.localGearId = localGearId;
  const gear = await resolveGearSummary(db, userId, localGearId);
  return toActivityDto(activity, relatedEvents.map(toActivityEventDto), gear);
}

export async function getSegments(db: Db, userId: string, activityId: number) {
  await activityRepo.requireOwnedActivity(db, userId, activityId);

  const consent = await userHasHeartRateConsent(db, userId);
  const segments = await getSegmentsForActivity(db, userId, activityId, consent);
  if (!consent) {
    for (const s of segments) s.avgHeartRate = null;
  }
  return { intervalSegments: segments };
}

export interface UpdateActivityInput {
  trainingType?: TrainingType | null;
  notes?: string | null;
  feeling?: number | null;
}

export async function updateMetadata(
  db: Db,
  userId: string,
  activityId: number,
  data: UpdateActivityInput,
): Promise<ActivityDto> {
  const updates: Partial<InsertActivity> = {};
  if (data.trainingType != null) updates.trainingType = data.trainingType;
  if (data.notes != null) updates.notes = data.notes;
  if (data.feeling != null) updates.feeling = data.feeling;

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No valid data provided to update");
  }

  const updated = await activityRepo.updateMetadataForUser(db, userId, activityId, updates);
  if (!updated) {
    throw new AppError(404, "Activity not found or unauthorized");
  }
  if (data.trainingType != null) {
    recordTrainingTypeChange({ trainingType: data.trainingType, via: "manual" });
  }
  const gear = await resolveGearSummary(db, userId, updated.localGearId);
  return toActivityDto(updated, undefined, gear);
}

export async function assignGear(
  db: Db,
  userId: string,
  activityId: number,
  gearId: number | null,
): Promise<ActivityDto> {
  const res = await gearRepo.assignActivityToGear(db, userId, activityId, gearId);
  if (!res.found) throw new AppError(404, "Activity not found");
  const [activity, events] = await Promise.all([
    activityRepo.requireOwnedActivity(db, userId, activityId),
    eventRepo.listForActivity(db, activityId),
  ]);
  const gear = await resolveGearSummary(db, userId, activity.localGearId);
  return toActivityDto(activity, events.map(toActivityEventDto), gear);
}
