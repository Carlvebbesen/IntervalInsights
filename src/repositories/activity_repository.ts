import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  type AnalysisStatus,
  activities,
  activityEvents,
  type EventType,
  events,
  type InsertActivity,
  intervalStructures,
  type SelectActivity,
  type TrainingType,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** Repository for the `activities` table. The DAO is the full row. */
export type ActivityDao = SelectActivity;

export const PAGE_SIZE = 15;

// Projection used by the list endpoint.
const listColumns = {
  id: activities.id,
  title: activities.title,
  startDateLocal: activities.startDateLocal,
  distance: activities.distance,
  sportType: activities.sportType,
  indoor: activities.indoor,
  trainingType: activities.trainingType,
  trainingLoad: activities.trainingLoad,
  icuTrainingLoad: activities.icuTrainingLoad,
  averageHeartRate: activities.averageHeartRate,
} as const;

export type ActivityListRow = Pick<
  SelectActivity,
  | "id"
  | "title"
  | "startDateLocal"
  | "distance"
  | "sportType"
  | "indoor"
  | "trainingType"
  | "trainingLoad"
  | "icuTrainingLoad"
  | "averageHeartRate"
>;

export interface ActivityListFilters {
  page: number;
  search?: string;
  distance?: number;
  maxDistance?: number;
  sortBy?: "date" | "distance" | "load";
  order?: "asc" | "desc";
  trainingType?: TrainingType[];
  intervalStructureId?: number;
  sportTypes?: string[];
  signatures?: string[];
  dateFrom?: string;
  dateTo?: string;
  eventTypes?: EventType[];
  eventIds?: number[];
}

/**
 * Join-heavy list query (the repo "exception" for cross-table reads): filters
 * activities by signature (interval_structures) and linked events
 * (activity_events ⋈ events). Returns an empty list when a sub-filter excludes
 * everything, mirroring the original short-circuits.
 */
export async function listForUser(
  db: Db,
  userId: string,
  f: ActivityListFilters,
): Promise<ActivityListRow[]> {
  const filters: (SQL<unknown> | undefined)[] = [
    eq(activities.userId, userId),
    eq(activities.analysisStatus, "completed"),
  ];

  if (f.search) {
    filters.push(
      or(ilike(activities.title, `%${f.search}%`), ilike(activities.description, `%${f.search}%`)),
    );
  }
  if (f.trainingType?.length) filters.push(inArray(activities.trainingType, f.trainingType));
  if (f.distance) filters.push(gte(activities.distance, f.distance));
  if (f.maxDistance) filters.push(lte(activities.distance, f.maxDistance));
  if (f.intervalStructureId)
    filters.push(eq(activities.intervalStructureId, f.intervalStructureId));
  if (f.sportTypes?.length) filters.push(inArray(activities.sportType, f.sportTypes));
  if (f.dateFrom) filters.push(gte(activities.startDateLocal, new Date(f.dateFrom)));
  if (f.dateTo) filters.push(lte(activities.startDateLocal, new Date(f.dateTo)));

  if (f.signatures?.length) {
    const structs = await db
      .select({ id: intervalStructures.id })
      .from(intervalStructures)
      .where(inArray(intervalStructures.signature, f.signatures));
    const ids = structs.map((s) => s.id);
    if (ids.length === 0) return [];
    filters.push(inArray(activities.intervalStructureId, ids));
  }

  if (f.eventTypes?.length || f.eventIds?.length) {
    const eventFilters = [eq(events.userId, userId)];
    if (f.eventTypes?.length) eventFilters.push(inArray(events.eventType, f.eventTypes));
    if (f.eventIds?.length) eventFilters.push(inArray(events.id, f.eventIds));
    const linkedRows = await db
      .selectDistinct({ activityId: activityEvents.activityId })
      .from(activityEvents)
      .innerJoin(events, eq(events.id, activityEvents.eventId))
      .where(and(...eventFilters));
    const linkedActivityIds = linkedRows.map((r) => r.activityId);
    if (linkedActivityIds.length === 0) return [];
    filters.push(inArray(activities.id, linkedActivityIds));
  }

  const dir = f.order === "asc" ? asc : desc;
  const sortCol =
    f.sortBy === "distance"
      ? activities.distance
      : f.sortBy === "load"
        ? sql`COALESCE(${activities.trainingLoad}, ${activities.icuTrainingLoad})`
        : activities.startDateLocal;

  return db
    .select(listColumns)
    .from(activities)
    .where(and(...filters))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE)
    .orderBy(dir(sortCol));
}

/** Columns the heart-rate analysis endpoint reads per matching activity. */
const hrAnalysisColumns = {
  id: activities.id,
  startDateLocal: activities.startDateLocal,
  title: activities.title,
  trainingType: activities.trainingType,
  stravaActivityId: activities.stravaActivityId,
  intervalsIcuId: activities.intervalsIcuId,
  hasHeartrate: activities.hasHeartrate,
  averageHeartRate: activities.averageHeartRate,
  maxHeartRate: activities.maxHeartRate,
  medianHeartRate: activities.medianHeartRate,
  modeHeartRate: activities.modeHeartRate,
  workAvgHeartRate: activities.workAvgHeartRate,
  workMaxHeartRate: activities.workMaxHeartRate,
  workMedianHeartRate: activities.workMedianHeartRate,
  workModeHeartRate: activities.workModeHeartRate,
  hrStatsComputedAt: activities.hrStatsComputedAt,
} as const;

export type HrAnalysisRow = {
  -readonly [K in keyof typeof hrAnalysisColumns]: SelectActivity[K & keyof SelectActivity];
};

export interface HrAnalysisFilters {
  trainingType?: TrainingType[];
  signatures?: string[];
  dateFrom?: string;
  dateTo?: string;
}

/**
 * All completed activities for a user matching the HR-analysis filters, with no
 * pagination/cap (stats are read straight off the row, so this is a single
 * cheap query). Mirrors the filter semantics of `listForUser`: AND across
 * categories, OR within a category. Returns [] when the signature filter
 * resolves to no structures.
 */
export async function listForHrAnalysis(
  db: Db,
  userId: string,
  f: HrAnalysisFilters,
): Promise<HrAnalysisRow[]> {
  const filters: (SQL<unknown> | undefined)[] = [
    eq(activities.userId, userId),
    eq(activities.analysisStatus, "completed"),
  ];

  if (f.trainingType?.length) filters.push(inArray(activities.trainingType, f.trainingType));
  if (f.dateFrom) filters.push(gte(activities.startDateLocal, new Date(f.dateFrom)));
  if (f.dateTo) filters.push(lte(activities.startDateLocal, new Date(f.dateTo)));

  if (f.signatures?.length) {
    const structs = await db
      .select({ id: intervalStructures.id })
      .from(intervalStructures)
      .where(inArray(intervalStructures.signature, f.signatures));
    const ids = structs.map((s) => s.id);
    if (ids.length === 0) return [];
    filters.push(inArray(activities.intervalStructureId, ids));
  }

  return db
    .select(hrAnalysisColumns)
    .from(activities)
    .where(and(...filters))
    .orderBy(desc(activities.startDateLocal));
}

export function findByIdForUser(
  db: Db,
  userId: string,
  activityId: number,
): Promise<ActivityDao | undefined> {
  return db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, activityId), eq(a.userId, userId)),
  });
}

/** Returns the activity's local start date, or `undefined` if it isn't owned by the user. */
export async function getStartDateLocalForUser(
  db: Db,
  userId: string,
  activityId: number,
): Promise<Date | undefined> {
  const [row] = await db
    .select({ startDateLocal: activities.startDateLocal })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.userId, userId)));
  return row?.startDateLocal;
}

export async function updateMetadataForUser(
  db: Db,
  userId: string,
  activityId: number,
  updates: Partial<InsertActivity>,
): Promise<ActivityDao | undefined> {
  const [updated] = await db
    .update(activities)
    .set(updates)
    .where(and(eq(activities.id, activityId), eq(activities.userId, userId)))
    .returning();
  return updated;
}

/** Activities in the given analysis statuses, projected for the pending list. */
export function listPending(db: Db, userId: string, statuses: readonly AnalysisStatus[]) {
  return db
    .select({
      id: activities.id,
      stravaId: activities.stravaActivityId,
      trainingType: activities.trainingType,
      analysisStatus: activities.analysisStatus,
      draftAnalysisResult: activities.draftAnalysisResult,
      title: activities.title,
      notes: activities.notes,
      distance: activities.distance,
      movingTime: activities.movingTime,
      description: activities.description,
      indoor: activities.indoor,
      feeling: activities.feeling,
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), inArray(activities.analysisStatus, [...statuses])));
}

/** Minimal context for pace lap-derivation: is the activity indoor + its Strava id. */
export async function findPaceContext(
  db: Db,
  userId: string,
  activityId: number,
): Promise<{ indoor: boolean; stravaActivityId: number } | undefined> {
  return db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, activityId), eq(a.userId, userId)),
    columns: { indoor: true, stravaActivityId: true },
  });
}

/** Per-gear usage rows: one row per (gear, trainingType) with a count. */
export function getGearUsage(db: Db, userId: string) {
  return db
    .select({
      gearId: activities.gearId,
      trainingType: activities.trainingType,
      count: count(),
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), isNotNull(activities.gearId)))
    .groupBy(activities.gearId, activities.trainingType);
}

type HrStatValues = { avg: number; max: number; median: number; mode: number };

/**
 * Persist computed HR-distribution stats for an activity. Writes the
 * histogram-derived whole-activity median/mode and the work-interval variants,
 * and backfills averageHeartRate/maxHeartRate from the histogram only when they
 * are currently null (COALESCE), so device/intervals.icu values win when present.
 * `hrStatsComputedAt` is always set so we don't reattempt for activities that
 * have no usable HR data.
 */
export async function updateHrStats(
  db: Db,
  activityId: number,
  stats: { full: HrStatValues | null; work: HrStatValues | null },
): Promise<void> {
  const base = {
    medianHeartRate: stats.full?.median ?? null,
    modeHeartRate: stats.full?.mode ?? null,
    workAvgHeartRate: stats.work?.avg ?? null,
    workMaxHeartRate: stats.work?.max ?? null,
    workMedianHeartRate: stats.work?.median ?? null,
    workModeHeartRate: stats.work?.mode ?? null,
    hrStatsComputedAt: new Date(),
  };
  await db
    .update(activities)
    .set(
      stats.full
        ? {
            ...base,
            averageHeartRate: sql`COALESCE(${activities.averageHeartRate}, ${stats.full.avg})`,
            maxHeartRate: sql`COALESCE(${activities.maxHeartRate}, ${stats.full.max})`,
          }
        : base,
    )
    .where(eq(activities.id, activityId));
}

/** Delete all of a user's activities (interval_segments cascade via ON DELETE CASCADE). */
export async function deleteAllForUser(db: Db, userId: string): Promise<void> {
  await db.delete(activities).where(eq(activities.userId, userId));
}
