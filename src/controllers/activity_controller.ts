import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { runInBackground } from "../background";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import {
  type ActivityDto,
  type GearStatsItemDto,
  toActivityDto,
  toActivityListItemDto,
} from "../dtos/activity_dto";
import { toActivityEventDto } from "../dtos/event_dto";
import { AppError } from "../error";
import type { Logger } from "../logger";
import * as activityRepo from "../repositories/activity_repository";
import * as eventRepo from "../repositories/event_repository";
import type {
  InsertActivity,
  InsertIntervalSegment,
  SelectIntervalSegment,
  TrainingType,
} from "../schema";
import { activities, intervalSegments } from "../schema";
import type { ActivityListResponseSchema, PatchSegmentSchema } from "../schemas/api_schemas";
import { userHasHeartRateConsent } from "../services/heart_rate_consent_service";
import { intervalsApiService } from "../services/intervals_api_service";
import { enrichActivityFromIntervalsIcu } from "../services/intervals_link_service";
import {
  mapIntervalsRawToLaps,
  mapIntervalsStreamsToStreamSet,
} from "../services/intervals_mappers";
import { getSegmentsForActivity } from "../services/lap_derivation_service";
import {
  type FullSegmentSpec,
  recomputeSegmentStats,
  SegmentMappingError,
} from "../services/segment_mapping_service";
import { findMatchingStructure, persistSegmentsAndStructure } from "../services/signature_service";
import { stravaApiService } from "../services/strava_api_service";
import type { IGlobalBindings } from "../types/IRouters";
import type { StreamSet } from "../types/strava/IStream";

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

export async function getActivityDetail(
  db: Db,
  userId: string,
  clerkId: string,
  activityId: number,
  logger: Logger,
): Promise<ActivityDto> {
  const [activity, relatedEvents] = await Promise.all([
    activityRepo.findByIdForUser(db, userId, activityId),
    eventRepo.listForActivity(db, activityId),
  ]);

  if (!activity) {
    throw new AppError(404, "Activity not found");
  }

  // Backfill intervals.icu enrichment lazily, off the request path.
  if (!activity.intervalsIcuId || !activity.intervalsIcuEnrichedAt) {
    runInBackground(
      "intervals.enrichActivity",
      () => enrichActivityFromIntervalsIcu({ db }, { id: userId, clerkId }, activityId),
      { attributes: { "activity.id": activityId, "user.id": userId }, logger },
    );
  }

  return toActivityDto(activity, relatedEvents.map(toActivityEventDto));
}

export async function getSegments(db: Db, clerkId: string, activityId: number) {
  const segments = await getSegmentsForActivity(db, clerkId, activityId);
  return { intervalSegments: segments };
}

type OwnedActivity = NonNullable<Awaited<ReturnType<typeof activityRepo.findByIdForUser>>>;

async function applySegmentEdit(
  db: Db,
  userId: string,
  clerkUserId: string,
  activity: OwnedActivity,
  specs: FullSegmentSpec[],
): Promise<{ intervalSegments: SelectIntervalSegment[] }> {
  if (!activity.trainingType) {
    throw new AppError(400, "Activity has no training type — cannot edit segments");
  }
  const tag = `[applySegmentEdit activity=${activity.id}]`;

  const consent = await userHasHeartRateConsent(db, userId);
  const src = await resolveActivitySource(db, userId, clerkUserId, activity.id);
  const keys = consent
    ? (["time", "distance", "heartrate"] as const)
    : (["time", "distance"] as const);
  const streams =
    src.kind === "intervals"
      ? mapIntervalsStreamsToStreamSet(
          await intervalsApiService.getActivityStreams(src.token, src.externalId, [...keys]),
        )
      : await stravaApiService.getActivityStreams(src.token, src.externalId, [...keys]);
  if (!streams?.time || !streams?.distance) {
    throw new AppError(400, "Activity streams missing time/distance — cannot recompute stats");
  }
  const statsStreams = streams as Required<Pick<StreamSet, "time" | "distance">> &
    Pick<StreamSet, "heartrate">;

  let computed: InsertIntervalSegment[];
  try {
    computed = recomputeSegmentStats(statsStreams, specs, activity.id, tag);
  } catch (err) {
    if (err instanceof SegmentMappingError) {
      throw new AppError(400, err.message);
    }
    throw err;
  }

  const check = await findMatchingStructure(db, computed, activity.trainingType, userId);
  await persistSegmentsAndStructure(db, {
    activityId: activity.id,
    userId,
    trainingType: activity.trainingType,
    segments: computed,
    check,
    userNotes: activity.notes ?? "",
    feeling: activity.feeling ?? null,
    persistSegments: true,
    draftOverride: null,
  });

  return { intervalSegments: await loadStoredSegments(db, activity.id) };
}

function loadStoredSegments(db: Db, activityId: number) {
  return db
    .select()
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, activityId))
    .orderBy(asc(intervalSegments.segmentIndex));
}

export async function editSegments(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
  specs: FullSegmentSpec[],
) {
  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) {
    throw new AppError(404, "Activity not found");
  }
  return applySegmentEdit(db, userId, clerkUserId, activity, specs);
}

export async function editSingleSegment(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
  segmentId: number,
  patch: z.infer<typeof PatchSegmentSchema>,
) {
  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) {
    throw new AppError(404, "Activity not found");
  }

  const existing = await loadStoredSegments(db, activityId);
  if (!existing.some((s) => s.id === segmentId)) {
    throw new AppError(404, "Segment not found for this activity");
  }

  const specs: FullSegmentSpec[] = existing.map((s) => {
    if (s.id !== segmentId) {
      return {
        type: s.type,
        setGroupIndex: s.setGroupIndex,
        targetType: s.targetType,
        targetValue: s.targetValue,
        targetPace: s.targetPace,
        timeSeriesEndTime: s.timeSeriesEndTime,
      };
    }
    return {
      type: patch.type ?? s.type,
      setGroupIndex: patch.setGroupIndex ?? s.setGroupIndex,
      targetType: patch.targetType ?? s.targetType,
      targetValue: patch.targetValue ?? s.targetValue,
      targetPace: patch.targetPace !== undefined ? patch.targetPace : s.targetPace,
      timeSeriesEndTime: patch.timeSeriesEndTime ?? s.timeSeriesEndTime,
    };
  });

  return applySegmentEdit(db, userId, clerkUserId, activity, specs);
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
  return toActivityDto(updated);
}

export async function getGearStats(
  db: Db,
  userId: string,
  accessToken: string,
): Promise<{ stats: GearStatsItemDto[] }> {
  const rows = await activityRepo.getGearUsage(db, userId);

  const statsMap = new Map<
    string,
    { activityCount: number; trainingTypeCounts: Record<string, number> }
  >();
  for (const row of rows) {
    if (row.gearId === null) continue;
    const id = row.gearId;
    const rowCount = Number(row.count);
    const existing = statsMap.get(id);
    if (!existing) {
      statsMap.set(id, {
        activityCount: rowCount,
        trainingTypeCounts: row.trainingType ? { [row.trainingType]: rowCount } : {},
      });
    } else {
      existing.activityCount += rowCount;
      if (row.trainingType) {
        existing.trainingTypeCounts[row.trainingType] =
          (existing.trainingTypeCounts[row.trainingType] ?? 0) + rowCount;
      }
    }
  }

  const gearIds = [...statsMap.keys()];
  const gearDetails = await Promise.all(
    gearIds.map((id) => stravaApiService.getGear(accessToken, id)),
  );

  const stats = gearDetails
    .filter((gear) => !gear.retired)
    .map((gear) => {
      const agg = statsMap.get(gear.id);
      if (!agg) throw new Error(`Missing aggregated stats for gear ${gear.id}`);
      return {
        gearId: gear.id,
        gearName: gear.name,
        activityCount: agg.activityCount,
        trainingTypeCounts: agg.trainingTypeCounts,
        distanceKm: Math.round((gear.distance / 1000) * 10) / 10,
      };
    });

  return { stats };
}

/**
 * Resolves where an activity's time-series data should be fetched from,
 * intervals.icu-preferred (see the intervals-icu-primary-data-source decision).
 * Tokens are resolved lazily so these endpoints work for intervals-only users
 * who never linked Strava. Takes the INTERNAL activity id (not a Strava id).
 */
type ActivitySource =
  | { kind: "intervals"; token: string; externalId: string }
  | { kind: "strava"; token: string; externalId: number };

async function resolveActivitySource(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
): Promise<ActivitySource> {
  const row = await db.query.activities.findFirst({
    where: and(eq(activities.id, activityId), eq(activities.userId, userId)),
    columns: { intervalsIcuId: true, stravaActivityId: true },
  });
  if (!row) throw new AppError(404, "Activity not found");

  if (row.intervalsIcuId) {
    try {
      const token = await getIntervalsAccessToken(clerkUserId);
      return { kind: "intervals", token, externalId: row.intervalsIcuId };
    } catch (err) {
      // intervals not linked / token dead — fall back to Strava if we can.
      if (row.stravaActivityId == null) throw err;
    }
  }
  if (row.stravaActivityId != null) {
    const tokens = await getStravaAccessTokens(clerkUserId);
    return { kind: "strava", token: tokens.access_token, externalId: row.stravaActivityId };
  }
  throw new AppError(400, "Activity has no intervals.icu or Strava source to fetch from");
}

export async function getLaps(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
) {
  const src = await resolveActivitySource(db, userId, clerkUserId, activityId);
  if (src.kind === "intervals") {
    const raw = await intervalsApiService.getActivityIntervals(src.token, src.externalId);
    return mapIntervalsRawToLaps(raw);
  }
  return stravaApiService.getActivityLaps(src.token, src.externalId);
}

export async function getSplits(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
) {
  const src = await resolveActivitySource(db, userId, clerkUserId, activityId);
  // intervals.icu has no per-km splits_metric equivalent; the app derives splits
  // in-app from the distance stream. Strava still provides them directly.
  if (src.kind === "intervals") return [];
  const activity = await stravaApiService.getActivity(src.token, src.externalId);
  return activity.splits_metric ?? [];
}

export async function getHeartrateStream(
  db: Db,
  userId: string,
  accessToken: string,
  activityId: number,
) {
  const consent = await userHasHeartRateConsent(db, userId);
  if (!consent) {
    throw new AppError(403, "Heart-rate processing not enabled for this account");
  }
  return stravaApiService.getActivityStreams(accessToken, activityId, [
    "heartrate",
    "time",
    "distance",
  ]);
}

export async function getStreams(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
) {
  const consent = await userHasHeartRateConsent(db, userId);
  const src = await resolveActivitySource(db, userId, clerkUserId, activityId);

  const base = ["time", "distance", "altitude", "cadence", "velocity_smooth"] as const;
  const keys = consent ? ([...base, "heartrate"] as const) : base;

  let streams: StreamSet;
  if (src.kind === "intervals") {
    streams = mapIntervalsStreamsToStreamSet(
      await intervalsApiService.getActivityStreams(src.token, src.externalId, [...keys]),
    );
  } else {
    streams = await stravaApiService.getActivityStreams(src.token, src.externalId, [...keys]);
  }

  return {
    time: streams?.time?.data ?? [],
    distance: streams?.distance?.data ?? [],
    heartrate: consent ? (streams?.heartrate?.data ?? null) : null,
    altitude: streams?.altitude?.data ?? null,
    cadence: streams?.cadence?.data ?? null,
    velocity: streams?.velocity_smooth?.data ?? null,
  };
}

export async function getDraftSegments(
  db: Db,
  userId: string,
  accessToken: string,
  activityId: number,
) {
  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) {
    throw new AppError(404, "Activity not found");
  }
  if (activity.stravaActivityId == null) {
    throw new AppError(400, "Activity has no Strava id");
  }

  const proposedSegments = activity.draftAnalysisResult?.proposedSegments ?? [];
  const consent = await userHasHeartRateConsent(db, userId);

  const keys = ["time", "velocity_smooth", "distance"] as const;
  const streamKeys = consent ? ([...keys, "heartrate"] as const) : keys;
  const streams = await stravaApiService.getActivityStreams(
    accessToken,
    activity.stravaActivityId,
    [...streamKeys],
  );

  return {
    proposedSegments,
    streams: {
      time: streams?.time?.data ?? [],
      heartrate: consent ? (streams?.heartrate?.data ?? null) : null,
      velocity: streams?.velocity_smooth?.data ?? [],
    },
  };
}
