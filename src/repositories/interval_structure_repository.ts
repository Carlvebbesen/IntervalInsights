import { and, asc, avg, count, desc, eq } from "drizzle-orm";
import { max, sql } from "drizzle-orm";
import { activities, intervalSegments, intervalStructures } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** Repository for the `interval_structures` table. */

/**
 * Distinct interval structures the user has at least one activity linked to,
 * with how many times they've done it and when they last did. Ordered by most
 * recently performed so repeated, comparable sessions surface first.
 */
export function listDistinctForUser(db: Db, userId: string) {
  return db
    .select({
      id: intervalStructures.id,
      name: intervalStructures.name,
      signature: intervalStructures.signature,
      activityCount: count(activities.id),
      lastDoneAt: max(activities.startDateLocal),
    })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(eq(activities.userId, userId))
    .groupBy(intervalStructures.id, intervalStructures.name, intervalStructures.signature)
    .orderBy(sql`MAX(${activities.startDateLocal}) DESC`);
}

/**
 * Every activity the user has linked to a given interval structure, oldest →
 * newest, with a per-session summary of the work reps (count, average work pace
 * in sec/km, average work HR) derived from `interval_segments`. Use to track how
 * a repeated session has progressed over time.
 */
export function structureHistory(db: Db, userId: string, structureId: number) {
  const workPaceExpr = sql`CASE WHEN ${intervalSegments.actualDistance} > 0 THEN ${intervalSegments.actualDuration}::float / ${intervalSegments.actualDistance} * 1000 ELSE NULL END`;
  const targetWorkPaceExpr = sql`CASE WHEN ${intervalSegments.targetPace} > 0 THEN 1000.0 / ${intervalSegments.targetPace} ELSE NULL END`;
  return db
    .select({
      activityId: activities.id,
      date: activities.startDateLocal,
      title: activities.title,
      indoor: activities.indoor,
      distance: activities.distance,
      movingTime: activities.movingTime,
      avgHeartRate: activities.averageHeartRate,
      load: sql<number | null>`COALESCE(${activities.trainingLoad}, ${activities.icuTrainingLoad})`,
      workRepCount: count(intervalSegments.id),
      avgWorkPaceSecPerKm: avg(workPaceExpr),
      fastestWorkPaceSecPerKm: sql<string | null>`MIN(${workPaceExpr})`,
      slowestWorkPaceSecPerKm: sql<string | null>`MAX(${workPaceExpr})`,
      targetWorkPaceSecPerKm: avg(targetWorkPaceExpr),
      avgWorkHr: avg(intervalSegments.avgHeartRate),
      minWorkHr: sql<string | null>`MIN(${intervalSegments.avgHeartRate})`,
      maxWorkHr: sql<string | null>`MAX(${intervalSegments.avgHeartRate})`,
    })
    .from(activities)
    .leftJoin(
      intervalSegments,
      and(eq(intervalSegments.activityId, activities.id), eq(intervalSegments.type, "INTERVALS")),
    )
    .where(and(eq(activities.userId, userId), eq(activities.intervalStructureId, structureId)))
    .groupBy(activities.id)
    .orderBy(asc(activities.startDateLocal));
}

/**
 * The work segments of the most recent activity linked to a structure that
 * actually has interval segments, ordered as performed. Used to reconstruct a
 * workout shape for structures whose activities never stored a draft structure
 * (e.g. sync-imported sessions).
 */
export async function representativeIntervalSegments(db: Db, userId: string, structureId: number) {
  const rep = await db
    .select({ id: activities.id })
    .from(activities)
    .innerJoin(
      intervalSegments,
      and(eq(intervalSegments.activityId, activities.id), eq(intervalSegments.type, "INTERVALS")),
    )
    .where(and(eq(activities.userId, userId), eq(activities.intervalStructureId, structureId)))
    .groupBy(activities.id)
    .orderBy(desc(activities.startDateLocal))
    .limit(1);

  const activityId = rep[0]?.id;
  if (activityId == null) return [];

  // All types (not just INTERVALS): between-set / single-rep-set recovery is
  // stored as separate ACTIVE_REST rows whose target_value holds the rest.
  return db
    .select({
      setGroupIndex: intervalSegments.setGroupIndex,
      segmentIndex: intervalSegments.segmentIndex,
      type: intervalSegments.type,
      targetType: intervalSegments.targetType,
      targetValue: intervalSegments.targetValue,
      recoveryTargetType: intervalSegments.recoveryTargetType,
      recoveryTargetValue: intervalSegments.recoveryTargetValue,
      actualDuration: intervalSegments.actualDuration,
      timeSeriesEndTime: intervalSegments.timeSeriesEndTime,
    })
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, activityId))
    .orderBy(asc(intervalSegments.segmentIndex));
}

export async function getStructureWithSets(db: Db, userId: string, structureId: number) {
  const structure = await db.query.intervalStructures.findFirst({
    where: eq(intervalStructures.id, structureId),
    columns: { id: true, name: true, signature: true, trainingType: true },
  });
  if (!structure) return null;

  const rows = await db
    .select({
      structure: activities.draftAnalysisResult,
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), eq(activities.intervalStructureId, structureId)))
    .orderBy(desc(activities.startDateLocal))
    .limit(5);

  let sets: NonNullable<
    NonNullable<(typeof rows)[number]["structure"]>["structure"]
  > | null = null;
  for (const r of rows) {
    const candidate = r.structure?.structure;
    if (candidate && candidate.length > 0) {
      sets = candidate;
      break;
    }
  }

  return {
    id: structure.id,
    name: structure.name,
    signature: structure.signature,
    trainingType: structure.trainingType,
    sets,
  };
}
