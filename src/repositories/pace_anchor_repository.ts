import { and, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { activities, intervalSegments, RUNNING_SPORT_TYPES } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

const RUNNING_TYPES = [...RUNNING_SPORT_TYPES];

export interface StoredEffortRow {
  durationSec: number;
  distanceM: number;
}

export function intervalRepEfforts(
  db: Db,
  userId: string,
  since: Date,
  until: Date,
): Promise<StoredEffortRow[]> {
  return db
    .select({
      durationSec: intervalSegments.actualDuration,
      distanceM: intervalSegments.actualDistance,
    })
    .from(intervalSegments)
    .innerJoin(activities, eq(intervalSegments.activityId, activities.id))
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, RUNNING_TYPES),
        gte(activities.startDateLocal, since),
        lte(activities.startDateLocal, until),
        eq(intervalSegments.type, "INTERVALS"),
        gt(intervalSegments.actualDistance, 0),
        gt(intervalSegments.actualDuration, 0),
      ),
    );
}

export function raceEfforts(
  db: Db,
  userId: string,
  since: Date,
  until: Date,
): Promise<StoredEffortRow[]> {
  return db
    .select({
      durationSec: activities.movingTime,
      distanceM: activities.distance,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, RUNNING_TYPES),
        eq(activities.trainingType, "RACE"),
        gte(activities.startDateLocal, since),
        lte(activities.startDateLocal, until),
        gt(activities.distance, 0),
        gt(activities.movingTime, 0),
      ),
    );
}
