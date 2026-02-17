import { TGlobalEnv } from "../types/IRouters";
import { activities } from "../schema";
import { eq, and, gte, lte, sql, avg, sum, count, or } from "drizzle-orm";
import { Hono } from "hono";

const dashboardRouter = new Hono<TGlobalEnv>();

function getStartOfWeek(date: Date) {
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

  const stats = await c.env.db
    .select({
      thisWeekKm: sum(sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`),
      prevWeekKm: sum(sql`CASE WHEN ${activities.startDateLocal} >= ${startOfPrevWeek} AND ${activities.startDateLocal} < ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`),
      last7DaysKm: sum(sql`CASE WHEN ${activities.startDateLocal} >= ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`),
      prev7DaysKm: sum(sql`CASE WHEN ${activities.startDateLocal} >= ${fourteenDaysAgo} AND ${activities.startDateLocal} < ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`),
      
      thisWeekFeeling: avg(sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.feeling} ELSE NULL END`),
      lastMonthFeeling: avg(sql`CASE WHEN ${activities.startDateLocal} >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)} THEN ${activities.feeling} ELSE NULL END`),
    })
    .from(activities)
    .where(eq(activities.userId, userId));

  const result = stats[0];
  const thisWeekKm = (Number(result.thisWeekKm) || 0) / 1000;
  const prevWeekKm = (Number(result.prevWeekKm) || 0) / 1000;
  const last7DaysKm = (Number(result.last7DaysKm) || 0) / 1000;
  const prev7DaysKm = (Number(result.prev7DaysKm) || 0) / 1000;

  const weekPercentChange = prevWeekKm === 0 ? 0 : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;
  const sevenDayPercentChange = prev7DaysKm === 0 ? 0 : ((last7DaysKm - prev7DaysKm) / prev7DaysKm) * 100;
  const eightWeeksAgo = new Date(startOfThisWeek);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 7 * 8);

  const weeklyData = await c.env.db
    .select({
      weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})`,
      totalDistance: sum(activities.distance),
    })
    .from(activities)
    .where(and(
      eq(activities.userId, userId),
      gte(activities.startDateLocal, eightWeeksAgo)
    ))
    .groupBy(sql`DATE_TRUNC('week', ${activities.startDateLocal})`)
    .orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);
  const graphData = [];
  for (let i = 8; i >= 0; i--) {
    const d = new Date(startOfThisWeek);
    d.setDate(d.getDate() - 7 * i);
    const dateStr = d.toISOString().split('T')[0];

    const match = weeklyData.find(w => {
        const wDate = new Date(w.weekStart);
        return wDate.getTime() === d.getTime();
    });
    
    graphData.push({
      date: dateStr,
      km: match ? (Number(match.totalDistance) || 0) / 1000 : 0
    });
  }

  const intervalTypes = ['TEMPO', 'PROGRESSIVE_LONG_RUN', 'LONG_INTERVALS', 'SHORT_INTERVALS', 'SPRINTS', 'HILL_SPRINTS', 'FARTLEK'];
  
  const longTermStats = await c.env.db
    .select({
      totalSessions: count(),
      totalIntervals: count(sql`CASE WHEN ${activities.trainingType} IN (${sql.raw(intervalTypes.map(t => `'${t}'`).join(','))}) THEN 1 ELSE NULL END`),
    })
    .from(activities)
    .where(and(
      eq(activities.userId, userId),
      gte(activities.startDateLocal, eightWeeksAgo)
    ));

  const numWeeks = 9;
  const avgSessionsPerWeek = (longTermStats[0].totalSessions || 0) / numWeeks;
  const avgIntervalsPerWeek = (Number(longTermStats[0].totalIntervals) || 0) / numWeeks;

  return c.json({
    summary: {
      thisWeekKm,
      prevWeekKm,
      weekPercentChange,
      last7DaysKm,
      prev7DaysKm,
      sevenDayPercentChange,
    },
    graph: graphData,
    averages: {
      avgSessionsPerWeek,
      avgIntervalsPerWeek,
      avgFeelingWeek: Number(result.thisWeekFeeling) || null,
      avgFeelingMonth: Number(result.lastMonthFeeling) || null,
    }
  });
});

export default dashboardRouter;
