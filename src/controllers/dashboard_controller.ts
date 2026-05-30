import type { z } from "zod";
import { AppError } from "../error";
import * as dashboardRepo from "../repositories/dashboard_repository";
import { INTERVAL_TRAINING_TYPES, OTHER_SPORT_TYPES, RUNNING_SPORT_TYPES } from "../schema/enums";
import type {
  DashboardResponseSchema,
  FitnessDayResponseSchema,
  FitnessSeriesResponseSchema,
  TrainingSummaryResponseSchema,
  WeekDetailResponseSchema,
  WellnessSeriesResponseSchema,
} from "../schemas/api_schemas";
import { fetchFitnessDayBlock, fetchFitnessSeries } from "../services/fitness_service";
import {
  fetchTrainingSummary,
  fetchWeekWellnessStats,
  fetchWellnessSeries,
  fetchWellnessSummary,
} from "../services/intervals_wellness_service";
import { ellipticalTimeToMetres, isTimeBased, toISODate } from "../services/utils";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

const INTERVAL_TRAINING_TYPE_SET = new Set<string>(INTERVAL_TRAINING_TYPES);

function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getDashboard(
  db: Db,
  userId: string,
  clerkUserId: string,
  now: Date,
): Promise<z.infer<typeof DashboardResponseSchema>> {
  const startOfThisWeek = getStartOfWeek(now);
  const startOfPrevWeek = new Date(startOfThisWeek);
  startOfPrevWeek.setUTCDate(startOfPrevWeek.getUTCDate() - 7);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);

  const eightWeeksAgo = new Date(startOfThisWeek);
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 7 * 8);
  const msInDay = 24 * 60 * 60 * 1000;
  const utcDay = now.getUTCDay();
  const dayOfWeek = utcDay === 0 ? 6 : utcDay - 1;
  const daysElapsed = dayOfWeek + 1;

  const runningTypes = [...RUNNING_SPORT_TYPES];

  const result = await dashboardRepo.runningWeekSummary(db, userId, runningTypes, {
    startOfThisWeek,
    startOfPrevWeek,
    sevenDaysAgo,
    fourteenDaysAgo,
    lastMonth: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
  });

  const thisWeekKm = (Number(result.thisWeekKm) || 0) / 1000;
  const prevWeekKm = (Number(result.prevWeekKm) || 0) / 1000;
  const last7DaysKm = (Number(result.last7DaysKm) || 0) / 1000;
  const prev7DaysKm = (Number(result.prev7DaysKm) || 0) / 1000;

  const weekPercentChange = prevWeekKm === 0 ? 0 : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;
  const sevenDayPercentChange =
    prev7DaysKm === 0 ? 0 : ((last7DaysKm - prev7DaysKm) / prev7DaysKm) * 100;

  const fourWeeksAgo = new Date(startOfThisWeek);
  fourWeeksAgo.setUTCDate(fourWeeksAgo.getUTCDate() - 7 * 4);

  const pastFourWeeksRuns = await dashboardRepo.runsBetween(
    db,
    userId,
    runningTypes,
    fourWeeksAgo,
    startOfThisWeek,
  );

  const pastWeekDistances: number[] = [];
  for (let w = 1; w <= 4; w++) {
    const weekStart = new Date(startOfThisWeek);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7 * w);
    const weekCutoff = new Date(weekStart.getTime() + daysElapsed * msInDay);

    const distInWindow = pastFourWeeksRuns
      .filter((r) => {
        const d = new Date(r.startDateLocal);
        return d >= weekStart && d < weekCutoff;
      })
      .reduce((acc, r) => acc + (r.distance || 0), 0);

    pastWeekDistances.push(distInWindow / 1000);
  }

  const avgKmByThisPointInWeek =
    pastWeekDistances.length > 0
      ? pastWeekDistances.reduce((a, b) => a + b, 0) / pastWeekDistances.length
      : 0;

  const weightedWeekPercentChange =
    avgKmByThisPointInWeek === 0
      ? 0
      : ((thisWeekKm - avgKmByThisPointInWeek) / avgKmByThisPointInWeek) * 100;

  const weeklyRunData = await dashboardRepo.weeklyRunDistanceSince(
    db,
    userId,
    runningTypes,
    eightWeeksAgo,
  );

  const otherTypes = [...OTHER_SPORT_TYPES];
  const otherActivitiesRaw = await dashboardRepo.weeklyOtherSince(
    db,
    userId,
    otherTypes,
    eightWeeksAgo,
  );

  const graphData = [];
  for (let i = 8; i >= 0; i--) {
    const weekStart = new Date(startOfThisWeek);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7 * i);
    const dateStr = toISODate(weekStart);
    const runMatch = weeklyRunData.find((w) => w.weekStart === dateStr);
    const runKm = runMatch ? (Number(runMatch.totalDistance) || 0) / 1000 : 0;

    const otherRows = otherActivitiesRaw.filter((w) => w.weekStart === dateStr);

    let otherKm = 0;
    const otherBreakdown: Record<string, number> = {};
    for (const row of otherRows) {
      const sport = row.sportType;
      const km = isTimeBased(sport)
        ? ellipticalTimeToMetres(Number(row.totalMovingTime) || 0) / 1000
        : (Number(row.totalDistance) || 0) / 1000;
      otherKm += km;
      otherBreakdown[sport] = (otherBreakdown[sport] || 0) + km;
    }

    graphData.push({ date: dateStr, runKm, otherKm, otherBreakdown, totalKm: runKm + otherKm });
  }

  const longTermStats = await dashboardRepo.longTermRunStatsSince(
    db,
    userId,
    runningTypes,
    eightWeeksAgo,
  );

  const numWeeks = 9;
  const avgSessionsPerWeek = (longTermStats.totalSessions || 0) / numWeeks;
  const avgIntervalsPerWeek = (Number(longTermStats.totalIntervals) || 0) / numWeeks;
  const avgElevationPerRun = Number(longTermStats.avgElevationPerRun) || null;
  const avgDistancePerRunKm = longTermStats.avgDistancePerRun
    ? (Number(longTermStats.avgDistancePerRun) || 0) / 1000
    : null;

  const todayStr = toISODate(now);
  const weekAgoStr = toISODate(sevenDaysAgo);
  const wellness = await fetchWellnessSummary(clerkUserId, weekAgoStr, todayStr);

  return {
    summary: {
      thisWeekKm,
      prevWeekKm,
      last7DaysKm,
      prev7DaysKm,
      weekPercentChange,
      sevenDayPercentChange,
      weightedWeekPercentChange,
      avgKmByThisPointInWeek,
      thisWeekElevationGain: Number(result.thisWeekElevation) || 0,
      thisWeekMovingTimeSec: Number(result.thisWeekMovingTime) || 0,
      thisWeekAvgHeartRate: Number(result.thisWeekAvgHR) || null,
    },
    graph: graphData,
    averages: {
      avgSessionsPerWeek,
      avgIntervalsPerWeek,
      avgFeelingWeek: Number(result.thisWeekFeeling) || null,
      avgFeelingMonth: Number(result.lastMonthFeeling) || null,
      avgElevationPerRun,
      avgDistancePerRunKm,
    },
    wellness,
  };
}

export function getTrainingSummary(
  clerkUserId: string,
): Promise<z.infer<typeof TrainingSummaryResponseSchema>> {
  return fetchTrainingSummary(clerkUserId);
}

export function getWellnessSeries(
  clerkUserId: string,
  oldest: string,
  newest: string,
): Promise<z.infer<typeof WellnessSeriesResponseSchema>> {
  return fetchWellnessSeries(clerkUserId, oldest, newest);
}

export function getFitnessSeries(
  clerkUserId: string,
  oldest: string,
  newest: string,
): Promise<z.infer<typeof FitnessSeriesResponseSchema>> {
  return fetchFitnessSeries(clerkUserId, oldest, newest);
}

export async function getFitnessDay(
  db: Db,
  userId: string,
  clerkUserId: string,
  date: string,
): Promise<z.infer<typeof FitnessDayResponseSchema>> {
  const [fitness, dayActivities] = await Promise.all([
    fetchFitnessDayBlock(clerkUserId, date),
    dashboardRepo.activitiesOnDate(db, userId, date),
  ]);
  return { date, fitness, activities: dayActivities };
}

export async function getWeekDetail(
  db: Db,
  userId: string,
  clerkUserId: string,
  weekStartParam: string,
): Promise<z.infer<typeof WeekDetailResponseSchema>> {
  const weekStart = new Date(weekStartParam);
  if (Number.isNaN(weekStart.getTime())) {
    throw new AppError(
      400,
      "Invalid weekStart date. Use ISO format: YYYY-MM-DD (Monday of the target week)",
    );
  }
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);
  const prevWeekEnd = weekStart;
  const monthAgoWeekStart = new Date(weekStart);
  monthAgoWeekStart.setUTCDate(monthAgoWeekStart.getUTCDate() - 28);
  const monthAgoWeekEnd = new Date(monthAgoWeekStart);
  monthAgoWeekEnd.setUTCDate(monthAgoWeekEnd.getUTCDate() + 7);

  const runningTypes = [...RUNNING_SPORT_TYPES];
  const otherTypes = [...OTHER_SPORT_TYPES];

  const rs = await dashboardRepo.weekRunningStats(db, userId, runningTypes, {
    weekStart,
    weekEnd,
    prevWeekStart,
    prevWeekEnd,
    monthAgoWeekStart,
    monthAgoWeekEnd,
  });

  const thisWeekKm = (Number(rs.thisWeekDistance) || 0) / 1000;
  const prevWeekKm = (Number(rs.prevWeekDistance) || 0) / 1000;
  const monthAgoKm = (Number(rs.monthAgoDistance) || 0) / 1000;
  const thisWeekMovingTimeSec = Number(rs.thisWeekMovingTime) || 0;

  const percentChangeVsPrevWeek =
    prevWeekKm === 0 ? null : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;
  const percentChangeVsSameWeek1MonthAgo =
    monthAgoKm === 0 ? null : ((thisWeekKm - monthAgoKm) / monthAgoKm) * 100;
  const avgPaceMinPerKm =
    thisWeekKm > 0 && thisWeekMovingTimeSec > 0 ? thisWeekMovingTimeSec / 60 / thisWeekKm : null;

  const thisWeekSessions = Number(rs.thisWeekSessions) || 0;
  const thisWeekIndoor = Number(rs.thisWeekIndoor) || 0;
  const thisWeekOutdoor = thisWeekSessions - thisWeekIndoor;

  const weekActivities = await dashboardRepo.weekActivityTrainingTypes(
    db,
    userId,
    runningTypes,
    weekStart,
    weekEnd,
  );

  const trainingTypeBreakdown: Record<string, number> = {};
  for (const { trainingType } of weekActivities) {
    if (!trainingType) continue;
    trainingTypeBreakdown[trainingType] = (trainingTypeBreakdown[trainingType] ?? 0) + 1;
  }

  const intervalCount = weekActivities.filter(
    (a) => a.trainingType && INTERVAL_TRAINING_TYPE_SET.has(a.trainingType),
  ).length;

  const otherActivitiesRaw = await dashboardRepo.weekOtherActivities(
    db,
    userId,
    otherTypes,
    weekStart,
    weekEnd,
  );

  let otherCombinedKm = 0;
  const otherActivities = otherActivitiesRaw.map((row) => {
    const sport = row.sportType;
    const km = isTimeBased(sport)
      ? ellipticalTimeToMetres(Number(row.totalMovingTime) || 0) / 1000
      : (Number(row.totalDistance) || 0) / 1000;
    otherCombinedKm += km;
    return { sportType: sport, km, movingTimeSec: Number(row.totalMovingTime) || 0 };
  });

  const lastDayOfWeek = new Date(weekEnd);
  lastDayOfWeek.setUTCDate(lastDayOfWeek.getUTCDate() - 1);
  const wellness = await fetchWeekWellnessStats(
    clerkUserId,
    toISODate(weekStart),
    toISODate(lastDayOfWeek),
  );

  return {
    weekStart: weekStartParam,
    running: {
      totalKm: thisWeekKm,
      totalElevationGain: Number(rs.thisWeekElevation) || 0,
      totalMovingTimeSec: thisWeekMovingTimeSec,
      avgHeartRate: Number(rs.thisWeekAvgHR) || null,
      avgPaceMinPerKm,
      numSessions: thisWeekSessions,
      indoorSessions: thisWeekIndoor,
      outdoorSessions: thisWeekOutdoor,
      avgFeeling: Number(rs.thisWeekFeeling) || null,
      percentChangeVsPrevWeek,
      percentChangeVsSameWeek1MonthAgo,
      prevWeekKm,
      monthAgoWeekKm: monthAgoKm,
      trainingTypeBreakdown,
    },
    intervals: { count: intervalCount },
    otherActivities: { combinedKm: otherCombinedKm, breakdown: otherActivities },
    wellness,
  };
}
