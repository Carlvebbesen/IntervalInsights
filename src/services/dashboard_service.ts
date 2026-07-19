import type { z } from "zod";
import * as dashboardRepo from "../repositories/dashboard_repository";
import { OTHER_SPORT_TYPES, RUNNING_SPORT_TYPES } from "../schema/enums";
import type { DashboardResponseSchema } from "../schemas/api_schemas";
import type { IGlobalBindings } from "../types/IRouters";
import { fetchWellnessSummary } from "./intervals_wellness_service";
import { ellipticalTimeToMetres, isTimeBased, toISODate } from "./utils";

type Db = IGlobalBindings["db"];

const GRAPH_WEEKS = 16;

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
  now: Date,
): Promise<z.infer<typeof DashboardResponseSchema>> {
  const startOfThisWeek = getStartOfWeek(now);
  const startOfPrevWeek = new Date(startOfThisWeek);
  startOfPrevWeek.setUTCDate(startOfPrevWeek.getUTCDate() - 7);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);

  const graphWindowStart = new Date(startOfThisWeek);
  graphWindowStart.setUTCDate(graphWindowStart.getUTCDate() - 7 * (GRAPH_WEEKS - 1));
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
    graphWindowStart,
  );

  const otherTypes = [...OTHER_SPORT_TYPES];
  const otherActivitiesRaw = await dashboardRepo.weeklyOtherSince(
    db,
    userId,
    otherTypes,
    graphWindowStart,
  );

  const graphData = [];
  for (let i = GRAPH_WEEKS - 1; i >= 0; i--) {
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
    graphWindowStart,
  );

  const avgSessionsPerWeek = (longTermStats.totalSessions || 0) / GRAPH_WEEKS;
  const avgIntervalsPerWeek = (Number(longTermStats.totalIntervals) || 0) / GRAPH_WEEKS;
  const avgElevationPerRun = Number(longTermStats.avgElevationPerRun) || null;
  const avgDistancePerRunKm = longTermStats.avgDistancePerRun
    ? (Number(longTermStats.avgDistancePerRun) || 0) / 1000
    : null;

  const todayStr = toISODate(now);
  const weekAgoStr = toISODate(sevenDaysAgo);
  const wellness = await fetchWellnessSummary(db, userId, weekAgoStr, todayStr);

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
