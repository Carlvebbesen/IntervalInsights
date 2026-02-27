import { TGlobalEnv } from "../types/IRouters";
import { activities } from "../schema";
import { eq, and, gte, lte, sql, avg, sum, count, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { RUNNING_SPORT_TYPES, OTHER_SPORT_TYPES } from "../schema/enums";
import { ellipticalTimeToMetres, isTimeBased } from "../services.ts/utils";

const dashboardRouter = new Hono<TGlobalEnv>();
function getStartOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - (day === 0 ? 6 : day - 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

dashboardRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const now = new Date();

  const startOfThisWeek = getStartOfWeek(now);
  const startOfPrevWeek = new Date(startOfThisWeek);
  startOfPrevWeek.setDate(startOfPrevWeek.getDate() - 7);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const eightWeeksAgo = new Date(startOfThisWeek);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 7 * 8);
  const msElapsedThisWeek = now.getTime() - startOfThisWeek.getTime();
  const msInWeek = 7 * 24 * 60 * 60 * 1000;
  const weekProgressFraction = Math.min(msElapsedThisWeek / msInWeek, 1);

  const runningTypes = RUNNING_SPORT_TYPES as unknown as string[];

  const stats = await c.env.db
    .select({
      thisWeekKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`
      ),
      prevWeekKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfPrevWeek} AND ${activities.startDateLocal} < ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`
      ),
      last7DaysKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`
      ),
      prev7DaysKm: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${fourteenDaysAgo} AND ${activities.startDateLocal} < ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`
      ),
      thisWeekElevation: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.totalElevationGain} ELSE 0 END`
      ),
      thisWeekMovingTime: sum(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.movingTime} ELSE 0 END`
      ),
      thisWeekAvgHR: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} AND ${activities.averageHeartRate} IS NOT NULL THEN ${activities.averageHeartRate} ELSE NULL END`
      ),
      thisWeekFeeling: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.feeling} ELSE NULL END`
      ),
      lastMonthFeeling: avg(
        sql`CASE WHEN ${activities.startDateLocal} >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)} THEN ${activities.feeling} ELSE NULL END`
      ),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes)
      )
    );

  const result = stats[0];
  const thisWeekKm = (Number(result.thisWeekKm) || 0) / 1000;
  const prevWeekKm = (Number(result.prevWeekKm) || 0) / 1000;
  const last7DaysKm = (Number(result.last7DaysKm) || 0) / 1000;
  const prev7DaysKm = (Number(result.prev7DaysKm) || 0) / 1000;

  const weekPercentChange =
    prevWeekKm === 0 ? 0 : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;
  const sevenDayPercentChange =
    prev7DaysKm === 0
      ? 0
      : ((last7DaysKm - prev7DaysKm) / prev7DaysKm) * 100;

  const fourWeeksAgo = new Date(startOfThisWeek);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 7 * 4);

  const pastFourWeeksRuns = await c.env.db
    .select({
      startDateLocal: activities.startDateLocal,
      distance: activities.distance,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, fourWeeksAgo),
        lte(activities.startDateLocal, startOfThisWeek)
      )
    );

  const pastWeekDistances: number[] = [];
  for (let w = 1; w <= 4; w++) {
    const weekStart = new Date(startOfThisWeek);
    weekStart.setDate(weekStart.getDate() - 7 * w);
    const weekCutoff = new Date(
      weekStart.getTime() + weekProgressFraction * msInWeek
    );

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

  // ── 3. Running graph (8 weeks) ────────────────────────────────────────────

  const weeklyRunData = await c.env.db
    .select({
      weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})`,
      totalDistance: sum(activities.distance),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, eightWeeksAgo)
      )
    )
    .groupBy(sql`DATE_TRUNC('week', ${activities.startDateLocal})`)
    .orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);

  // ── 4. Other activities graph (8 weeks) ───────────────────────────────────

  const otherTypes = OTHER_SPORT_TYPES as unknown as string[];

  const otherActivitiesRaw = await c.env.db
    .select({
      weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})`,
      sportType: activities.sportType,
      totalDistance: sum(activities.distance),
      totalMovingTime: sum(activities.movingTime),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, otherTypes),
        gte(activities.startDateLocal, eightWeeksAgo)
      )
    )
    .groupBy(
      sql`DATE_TRUNC('week', ${activities.startDateLocal})`,
      activities.sportType
    )
    .orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);

  // ── 5. Build graph data ───────────────────────────────────────────────────

  const graphData = [];
  for (let i = 8; i >= 0; i--) {
    const weekStart = new Date(startOfThisWeek);
    weekStart.setDate(weekStart.getDate() - 7 * i);
    const dateStr = weekStart.toISOString().split("T")[0];

    const runMatch = weeklyRunData.find((w) => {
      const wDate = new Date(w.weekStart);
      return wDate.getTime() === weekStart.getTime();
    });
    const runKm = runMatch ? (Number(runMatch.totalDistance) || 0) / 1000 : 0;

    const otherRows = otherActivitiesRaw.filter((w) => {
      const wDate = new Date(w.weekStart);
      return wDate.getTime() === weekStart.getTime();
    });

    let otherKm = 0;
    const otherBreakdown: Record<string, number> = {};
    for (const row of otherRows) {
      const sport = row.sportType;
      let km: number;
      if (isTimeBased(sport)) {
        km = ellipticalTimeToMetres(Number(row.totalMovingTime) || 0) / 1000;
      } else {
        km = (Number(row.totalDistance) || 0) / 1000;
      }
      otherKm += km;
      otherBreakdown[sport] = (otherBreakdown[sport] || 0) + km;
    }

    graphData.push({
      date: dateStr,
      runKm,
      otherKm,
      otherBreakdown,
      totalKm: runKm + otherKm,
    });
  }

  const intervalTypes = [
    "TEMPO",
    "PROGRESSIVE_LONG_RUN",
    "LONG_INTERVALS",
    "SHORT_INTERVALS",
    "SPRINTS",
    "HILL_SPRINTS",
    "FARTLEK",
  ];

  const longTermStats = await c.env.db
    .select({
      totalSessions: count(),
      totalIntervals: count(
        sql`CASE WHEN ${activities.trainingType} IN (${sql.raw(
          intervalTypes.map((t) => `'${t}'`).join(",")
        )}) THEN 1 ELSE NULL END`
      ),
      avgElevationPerRun: avg(activities.totalElevationGain),
      avgDistancePerRun: avg(activities.distance),
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        inArray(activities.sportType, runningTypes),
        gte(activities.startDateLocal, eightWeeksAgo)
      )
    );

  const numWeeks = 9;
  const avgSessionsPerWeek = (longTermStats[0].totalSessions || 0) / numWeeks;
  const avgIntervalsPerWeek =
    (Number(longTermStats[0].totalIntervals) || 0) / numWeeks;
  const avgElevationPerRun =
    Number(longTermStats[0].avgElevationPerRun) || null;
  const avgDistancePerRunKm = longTermStats[0].avgDistancePerRun
    ? (Number(longTermStats[0].avgDistancePerRun) || 0) / 1000
    : null;

  // ── 7. Response ───────────────────────────────────────────────────────────

  return c.json({
    summary: {
      thisWeekKm,
      prevWeekKm,
      last7DaysKm,
      prev7DaysKm,
      weekPercentChange,
      sevenDayPercentChange,
      weightedWeekPercentChange,
      weekProgressFraction,
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
  });
});

export default dashboardRouter;
