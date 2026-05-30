import { and, asc, avg, count, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { activities, INTERVAL_TRAINING_TYPES } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/**
 * Aggregation queries backing the dashboard. These are activity-table rollups
 * (the repo "aggregation exception"); the controller owns the date-window math
 * and assembles the response from these raw rows.
 */

export interface DashboardWeekBoundaries {
  startOfThisWeek: Date;
  startOfPrevWeek: Date;
  sevenDaysAgo: Date;
  fourteenDaysAgo: Date;
  lastMonth: Date;
}

export async function runningWeekSummary(
  db: Db,
  userId: string,
  runningTypes: string[],
  b: DashboardWeekBoundaries,
) {
  const [row] = await db
    .select({
      thisWeekKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfThisWeek} THEN ${activities.distance} ELSE 0 END`,
      ),
      prevWeekKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfPrevWeek} AND ${activities.startDateLocal} < ${b.startOfThisWeek} THEN ${activities.distance} ELSE 0 END`,
      ),
      last7DaysKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`,
      ),
      prev7DaysKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.fourteenDaysAgo} AND ${activities.startDateLocal} < ${b.sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`,
      ),
      thisWeekElevation: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfThisWeek} THEN ${activities.totalElevationGain} ELSE 0 END`,
      ),
      thisWeekMovingTime: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfThisWeek} THEN ${activities.movingTime} ELSE 0 END`,
      ),
      thisWeekAvgHR: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfThisWeek} AND ${activities.averageHeartRate} IS NOT NULL THEN ${activities.averageHeartRate} ELSE NULL END`,
      ),
      thisWeekFeeling: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.startOfThisWeek} THEN ${activities.feeling} ELSE NULL END`,
      ),
      lastMonthFeeling: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.lastMonth} THEN ${activities.feeling} ELSE NULL END`,
      ),
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), inArray(activities.sportType, runningTypes)));
  return row;
}

export function runsBetween(db: Db, userId: string, runningTypes: string[], from: Date, to: Date) {
  return db
    .select({ startDateLocal: activities.startDateLocal, distance: activities.distance })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, from),
        lte(activities.startDateLocal, to),
      ),
    );
}

export function weeklyRunDistanceSince(
  db: Db,
  userId: string,
  runningTypes: string[],
  since: Date,
) {
  return db
    .select({
      weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})::date`,
      totalDistance: sum(activities.distance),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, since),
      ),
    )
    .groupBy(sql`DATE_TRUNC('week', ${activities.startDateLocal})`)
    .orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);
}

export function weeklyOtherSince(db: Db, userId: string, otherTypes: string[], since: Date) {
  return db
    .select({
      weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})::date`,
      sportType: activities.sportType,
      totalDistance: sum(activities.distance),
      totalMovingTime: sum(activities.movingTime),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, otherTypes),
        gte(activities.startDateLocal, since),
      ),
    )
    .groupBy(sql`DATE_TRUNC('week', ${activities.startDateLocal})`, activities.sportType)
    .orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);
}

export async function longTermRunStatsSince(
  db: Db,
  userId: string,
  runningTypes: string[],
  since: Date,
) {
  const [row] = await db
    .select({
      totalSessions: count(),
      totalIntervals: count(
        sql`CASE WHEN ${activities.trainingType} IN (${sql.raw(
          INTERVAL_TRAINING_TYPES.map((t) => `'${t}'`).join(","),
        )}) THEN 1 ELSE NULL END`,
      ),
      avgElevationPerRun: avg(activities.totalElevationGain),
      avgDistancePerRun: avg(activities.distance),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, since),
      ),
    );
  return row;
}

export interface WeekDetailBoundaries {
  weekStart: Date;
  weekEnd: Date;
  prevWeekStart: Date;
  prevWeekEnd: Date;
  monthAgoWeekStart: Date;
  monthAgoWeekEnd: Date;
}

export async function weekRunningStats(
  db: Db,
  userId: string,
  runningTypes: string[],
  b: WeekDetailBoundaries,
) {
  const [row] = await db
    .select({
      thisWeekDistance: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} THEN ${activities.distance} ELSE 0 END`,
      ),
      thisWeekElevation: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} THEN ${activities.totalElevationGain} ELSE 0 END`,
      ),
      thisWeekMovingTime: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} THEN ${activities.movingTime} ELSE 0 END`,
      ),
      thisWeekAvgHR: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} AND ${activities.averageHeartRate} IS NOT NULL THEN ${activities.averageHeartRate} ELSE NULL END`,
      ),
      thisWeekFeeling: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} THEN ${activities.feeling} ELSE NULL END`,
      ),
      thisWeekSessions: count(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} THEN 1 ELSE NULL END`,
      ),
      thisWeekIndoor: count(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.weekStart} AND ${activities.startDateLocal} < ${b.weekEnd} AND ${activities.indoor} = true THEN 1 ELSE NULL END`,
      ),
      prevWeekDistance: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.prevWeekStart} AND ${activities.startDateLocal} < ${b.prevWeekEnd} THEN ${activities.distance} ELSE 0 END`,
      ),
      monthAgoDistance: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${b.monthAgoWeekStart} AND ${activities.startDateLocal} < ${b.monthAgoWeekEnd} THEN ${activities.distance} ELSE 0 END`,
      ),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, b.monthAgoWeekStart),
        lte(activities.startDateLocal, b.weekEnd),
      ),
    );
  return row;
}

export function weekActivityTrainingTypes(
  db: Db,
  userId: string,
  runningTypes: string[],
  weekStart: Date,
  weekEnd: Date,
) {
  return db
    .select({ trainingType: activities.trainingType })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, weekStart),
        lte(activities.startDateLocal, weekEnd),
      ),
    );
}

export function weekOtherActivities(
  db: Db,
  userId: string,
  otherTypes: string[],
  weekStart: Date,
  weekEnd: Date,
) {
  return db
    .select({
      sportType: activities.sportType,
      totalDistance: sum(activities.distance),
      totalMovingTime: sum(activities.movingTime),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, otherTypes),
        gte(activities.startDateLocal, weekStart),
        lte(activities.startDateLocal, weekEnd),
      ),
    )
    .groupBy(activities.sportType);
}

export function activitiesOnDate(db: Db, userId: string, date: string) {
  return db
    .select({
      id: activities.id,
      title: activities.title,
      sportType: activities.sportType,
      trainingType: activities.trainingType,
      distance: activities.distance,
      movingTime: activities.movingTime,
      averageHeartRate: activities.averageHeartRate,
      trainingLoad: activities.trainingLoad,
      icuTrainingLoad: activities.icuTrainingLoad,
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), sql`DATE(${activities.startDateLocal}) = ${date}`))
    .orderBy(asc(activities.startDateLocal));
}
