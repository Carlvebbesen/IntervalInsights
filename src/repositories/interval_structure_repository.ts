import { and, asc, avg, count, eq, max, sql } from "drizzle-orm";
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
  return db
    .select({
      activityId: activities.id,
      date: activities.startDateLocal,
      title: activities.title,
      distance: activities.distance,
      movingTime: activities.movingTime,
      avgHeartRate: activities.averageHeartRate,
      load: sql<number | null>`COALESCE(${activities.trainingLoad}, ${activities.icuTrainingLoad})`,
      workRepCount: count(intervalSegments.id),
      avgWorkPaceSecPerKm: avg(
        sql`CASE WHEN ${intervalSegments.actualDistance} > 0 THEN ${intervalSegments.actualDuration}::float / ${intervalSegments.actualDistance} * 1000 ELSE NULL END`,
      ),
      avgWorkHr: avg(intervalSegments.avgHeartRate),
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
