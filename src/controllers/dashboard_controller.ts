import type { z } from "zod";
import { AppError } from "../error";
import * as dashboardRepo from "../repositories/dashboard_repository";
import { INTERVAL_TRAINING_TYPES, OTHER_SPORT_TYPES, RUNNING_SPORT_TYPES } from "../schema/enums";
import type {
  FitnessDayResponseSchema,
  FitnessSeriesResponseSchema,
  PaceAnchorResponseSchema,
  TrainingSummaryResponseSchema,
  WeekDetailResponseSchema,
} from "../schemas/api_schemas";
import { fetchFitnessDayBlock, fetchFitnessSeries } from "../services/fitness_service";
import { computeHeatModel, heatRaceDeltaSec, type WeatherInput } from "../services/heat_service";
import {
  fetchTrainingSummary,
  fetchWeekWellnessStats,
} from "../services/intervals_wellness_service";
import { fetchPaceAnchor } from "../services/pace_anchor_service";
import { ellipticalTimeToMetres, isTimeBased, toISODate } from "../services/utils";
import type { IGlobalBindings } from "../types/IRouters";

export { getDashboard } from "../services/dashboard_service";

type Db = IGlobalBindings["db"];

const INTERVAL_TRAINING_TYPE_SET = new Set<string>(INTERVAL_TRAINING_TYPES);

export async function getTrainingSummary(
  db: Db,
  userId: string,
  clerkUserId: string,
  localDate?: string,
): Promise<z.infer<typeof TrainingSummaryResponseSchema>> {
  // `activitiesOnDate` matches against `startDateLocal`, so "today" must be the
  // athlete's local calendar date. Fall back to the server's UTC date only when
  // the client doesn't supply one.
  const today = localDate ?? toISODate(new Date());
  const [summary, todayRows] = await Promise.all([
    fetchTrainingSummary(clerkUserId),
    dashboardRepo.activitiesOnDate(db, userId, today),
  ]);
  if (summary.status !== "ok") return summary;

  const todaySessions = todayRows.map((a) => ({
    sportType: a.sportType,
    trainingType: a.trainingType,
    movingTime: a.movingTime,
    load: a.icuTrainingLoad ?? a.trainingLoad,
  }));
  return {
    status: "ok",
    data: { ...summary.data, trainedToday: todayRows.length > 0, todaySessions },
  };
}

export async function getPaceAnchor(
  db: Db,
  userId: string,
  clerkUserId: string,
  weather?: WeatherInput,
): Promise<z.infer<typeof PaceAnchorResponseSchema>> {
  const result = await fetchPaceAnchor(db, userId, clerkUserId);
  if (result.status !== "ok" || !weather) return result;
  const predictedRaces = result.data.predictedRaces.map((r) => ({
    ...r,
    heatDeltaSec: heatRaceDeltaSec(weather, r.distanceM),
  }));
  return {
    status: "ok",
    data: { ...result.data, heat: computeHeatModel(weather), predictedRaces },
  };
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
