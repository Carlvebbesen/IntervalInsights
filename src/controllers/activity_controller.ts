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
import { gearDisplayName, toGearSummaryDto } from "../dtos/gear_dto";
import { AppError } from "../error";
import type { Logger } from "../logger";
import { recordSegmentEdit, recordTrainingTypeChange } from "../otel";
import * as activityRepo from "../repositories/activity_repository";
import * as eventRepo from "../repositories/event_repository";
import * as gearRepo from "../repositories/gear_repository";
import type {
  InsertActivity,
  InsertIntervalSegment,
  ProposedSegmentDraft,
  SelectIntervalSegment,
  TrainingType,
} from "../schema";
import { activities, intervalSegments } from "../schema";
import type { ActivityListResponseSchema, PatchSegmentSchema } from "../schemas/api_schemas";
import { userHasHeartRateConsent } from "../services/heart_rate_consent_service";
import { intervalsApiService } from "../services/intervals_api_service";
import { enrichActivityFromIntervalsIcu } from "../services/intervals_link_service";
import { linkActivityGearOnIngest } from "../services/gear_strava_service";
import {
  extractIntervalsList,
  mapIntervalsRawToLaps,
  mapIntervalsStreamsToStreamSet,
} from "../services/intervals_mappers";
import { produceSegments } from "../agent/segment_production";
import type { WorkoutAnalysisOutput, workoutSet } from "../agent/initial_analysis_agent";
import { getProposedPace } from "./analysis_controller";
import type { IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import { getSegmentsForActivity } from "../services/lap_derivation_service";
import {
  type FullSegmentSpec,
  recomputeSegmentStats,
  SegmentMappingError,
} from "../services/segment_mapping_service";
import { findMatchingStructure, persistSegmentsAndStructure } from "../services/signature_service";
import { expandRestSegments } from "../services/segment_fold_service";
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

/** Resolve the gear summary for an activity's localGearId (works for retired gear). */
async function resolveGearSummary(db: Db, userId: string, localGearId: number | null) {
  if (localGearId == null) return null;
  const summary = (await gearRepo.findSummariesByIds(db, userId, [localGearId])).get(localGearId);
  return summary ? toGearSummaryDto(summary) : null;
}

/**
 * Resolve the local gear id for an activity, self-healing the link on demand.
 * A local link always wins. Otherwise, if the activity still carries a Strava
 * gear id, link the matching local gear — importing it from Strava the first
 * time it's seen — so the detail page shows the right shoe even for activities
 * ingested before the local-gear feature. Best-effort: any failure (e.g. Strava
 * not linked) leaves the activity unlinked rather than failing the request.
 */
async function resolveActivityGearId(
  db: Db,
  userId: string,
  clerkId: string,
  activity: { id: number; localGearId: number | null; gearId: string | null; sportType: string; startDateLocal: Date },
  logger: Logger,
): Promise<number | null> {
  if (activity.localGearId != null) return activity.localGearId;
  const stravaGearId = activity.gearId;
  if (!stravaGearId) return null;

  // Already imported locally → just link this activity (no Strava call needed).
  const existing = await gearRepo.findByStravaGearId(db, userId, stravaGearId);
  if (existing) {
    await gearRepo.assignActivityToGear(db, userId, activity.id, existing.id);
    return existing.id;
  }

  // Not local yet → import from Strava (needs a token), then link.
  try {
    const { access_token } = await getStravaAccessTokens(clerkId);
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

  const localGearId = await resolveActivityGearId(db, userId, clerkId, activity, logger);
  activity.localGearId = localGearId;
  const gear = await resolveGearSummary(db, userId, localGearId);
  return toActivityDto(activity, relatedEvents.map(toActivityEventDto), gear);
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
  editKind: "bulk" | "single",
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

  recordSegmentEdit({ editKind, source: src.kind, trainingType: activity.trainingType });

  // Option B: expand folded recovery back into REST rows for the response shape.
  return { intervalSegments: expandRestSegments(await loadStoredSegments(db, activity.id)) };
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
  return applySegmentEdit(db, userId, clerkUserId, activity, specs, "bulk");
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

  // Option B: expand folded rests so edits operate on the full work + REST list.
  const existing = expandRestSegments(await loadStoredSegments(db, activityId));
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

  return applySegmentEdit(db, userId, clerkUserId, activity, specs, "single");
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

/**
 * @deprecated Legacy gear stats for older app builds — now served from LOCAL gear
 * (no Strava call). Keyed by Strava gear id so old clients can still resolve the
 * activity badge; manual shoes (no Strava id) are omitted. New clients use /api/gear.
 */
export async function getGearStats(
  db: Db,
  userId: string,
): Promise<{ stats: GearStatsItemDto[] }> {
  const [gearsList, countRows] = await Promise.all([
    gearRepo.listForUser(db, userId, { includeRetired: false }),
    gearRepo.trainingTypeCountsByGear(db, userId),
  ]);

  const counts = new Map<number, Record<string, number>>();
  for (const row of countRows) {
    if (row.gearId == null || !row.trainingType) continue;
    const m = counts.get(row.gearId) ?? {};
    m[row.trainingType] = (m[row.trainingType] ?? 0) + Number(row.count);
    counts.set(row.gearId, m);
  }

  const stats = gearsList
    .filter((g) => g.stravaGearId)
    .map((g) => ({
      gearId: g.stravaGearId as string,
      gearName: gearDisplayName(g),
      activityCount: g.activityCount,
      trainingTypeCounts: counts.get(g.id) ?? {},
      distanceKm:
        Math.round(((g.baselineDistanceMeters + g.maintainedDistanceMeters) / 1000) * 10) / 10,
    }));

  return { stats };
}

/** Assign (or clear, with gearId=null) the local gear on an activity. */
export async function assignGear(
  db: Db,
  userId: string,
  activityId: number,
  gearId: number | null,
): Promise<ActivityDto> {
  const res = await gearRepo.assignActivityToGear(db, userId, activityId, gearId);
  if (!res.found) throw new AppError(404, "Activity not found");
  const [activity, events] = await Promise.all([
    activityRepo.findByIdForUser(db, userId, activityId),
    eventRepo.listForActivity(db, activityId),
  ]);
  if (!activity) throw new AppError(404, "Activity not found");
  const gear = await resolveGearSummary(db, userId, activity.localGearId);
  return toActivityDto(activity, events.map(toActivityEventDto), gear);
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

export async function getStreamSet(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
): Promise<StreamSet> {
  const consent = await userHasHeartRateConsent(db, userId);
  const src = await resolveActivitySource(db, userId, clerkUserId, activityId);

  const base = ["time", "distance", "altitude", "cadence", "velocity_smooth"] as const;
  const keys = consent ? ([...base, "heartrate"] as const) : base;

  if (src.kind === "intervals") {
    return mapIntervalsStreamsToStreamSet(
      await intervalsApiService.getActivityStreams(src.token, src.externalId, [...keys]),
    );
  }
  return stravaApiService.getActivityStreams(src.token, src.externalId, [...keys]);
}

export async function getStreams(
  db: Db,
  userId: string,
  clerkUserId: string,
  activityId: number,
) {
  const streams = await getStreamSet(db, userId, clerkUserId, activityId);
  return {
    time: streams?.time?.data ?? [],
    distance: streams?.distance?.data ?? [],
    heartrate: streams?.heartrate?.data ?? null,
    altitude: streams?.altitude?.data ?? null,
    cadence: streams?.cadence?.data ?? null,
    velocity: streams?.velocity_smooth?.data ?? null,
  };
}

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
  clerkUserId: string,
  activityId: number,
  sets: ExpandedIntervalSet[],
  trainingType: TrainingType,
  logger: Logger,
): Promise<ProposedSegmentDraft[]> {
  const log = logger.child({ fn: "previewSegments", activityId });
  if (!sets || sets.length === 0) return [];

  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) throw new AppError(404, "Activity not found");

  const streamSet = await getStreamSet(db, userId, clerkUserId, activityId);
  const time = streamSet.time;
  const distance = streamSet.distance;
  if (!time?.data?.length || !distance?.data?.length) {
    throw new AppError(400, "Activity streams missing time/distance");
  }
  const statsStreams = { time, distance, heartrate: streamSet.heartrate };

  const laps = await getLaps(db, userId, clerkUserId, activityId);

  let intervalsIcuIntervals: IIntervalsInterval[] | null = null;
  if (activity.intervalsIcuId) {
    try {
      const token = await getIntervalsAccessToken(clerkUserId);
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
  const streams = await loadEditorStreams(db, userId, accessToken, activity.stravaActivityId);

  return { proposedSegments, streams };
}

type WorkoutSet = z.infer<typeof workoutSet>;

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
  clerkUserId: string,
  accessToken: string | undefined,
  activityId: number,
  input: {
    structure?: WorkoutSet[];
    sets?: ExpandedIntervalSet[];
    trainingType: TrainingType;
    includeStreams?: boolean;
  },
  logger: Logger,
): Promise<{ sets: ExpandedIntervalSet[]; segments: ProposedSegmentDraft[]; streams: EditorStreams | null }> {
  const log = logger.child({ fn: "getEditorState", activityId });

  const sets =
    input.sets ??
    (await getProposedPace(
      db,
      userId,
      clerkUserId,
      accessToken,
      input.structure ?? [],
      activityId,
      log,
    ));

  const segments = await previewSegments(
    db,
    userId,
    clerkUserId,
    activityId,
    sets,
    input.trainingType,
    log,
  );

  let streams: EditorStreams | null = null;
  if (input.includeStreams !== false && accessToken) {
    const activity = await activityRepo.findByIdForUser(db, userId, activityId);
    if (activity?.stravaActivityId != null) {
      streams = await loadEditorStreams(db, userId, accessToken, activity.stravaActivityId);
    }
  }

  return { sets, segments, streams };
}
