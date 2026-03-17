import { and, avg, count, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { activities } from "../schema";
import {
	INTERVAL_TRAINING_TYPES,
	OTHER_SPORT_TYPES,
	RUNNING_SPORT_TYPES,
	TrainingType,
} from "../schema/enums";
import {
	DashboardResponseSchema,
	ErrorSchema,
	WeekDetailResponseSchema,
} from "../schemas/api_schemas";
import { ellipticalTimeToMetres, isTimeBased } from "../services.ts/utils";
import type { TGlobalEnv } from "../types/IRouters";

const dashboardRouter = new Hono<TGlobalEnv>();
function getStartOfWeek(date: Date): Date {
	const d = new Date(date);
	const day = d.getUTCDay();
	const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1);
	d.setUTCDate(diff);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

dashboardRouter.get(
	"/",
	describeRoute({
		description: "Get dashboard summary, graph data, and averages",
		responses: {
			200: {
				description: "Dashboard data",
				content: {
					"application/json": { schema: resolver(DashboardResponseSchema) },
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	async (c) => {
		const userId = c.get("userId");
		const now = new Date();

		const startOfThisWeek = getStartOfWeek(now);
		const startOfPrevWeek = new Date(startOfThisWeek);
		startOfPrevWeek.setUTCDate(startOfPrevWeek.getUTCDate() - 7);

		const sevenDaysAgo = new Date(now);
		sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
		const fourteenDaysAgo = new Date(now);
		fourteenDaysAgo.setUTCDate(fourteenDaysAgo.getUTCDate() - 14);

		const eightWeeksAgo = new Date(startOfThisWeek);
		eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 7 * 8);
		const msElapsedThisWeek = now.getTime() - startOfThisWeek.getTime();
		const msInWeek = 7 * 24 * 60 * 60 * 1000;
		const weekProgressFraction = Math.min(msElapsedThisWeek / msInWeek, 1);

		const runningTypes = RUNNING_SPORT_TYPES as unknown as string[];

		const stats = await c.env.db
			.select({
				thisWeekKm: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`,
				),
				prevWeekKm: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfPrevWeek} AND ${activities.startDateLocal} < ${startOfThisWeek} THEN ${activities.distance} ELSE 0 END`,
				),
				last7DaysKm: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`,
				),
				prev7DaysKm: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${fourteenDaysAgo} AND ${activities.startDateLocal} < ${sevenDaysAgo} THEN ${activities.distance} ELSE 0 END`,
				),
				thisWeekElevation: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.totalElevationGain} ELSE 0 END`,
				),
				thisWeekMovingTime: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.movingTime} ELSE 0 END`,
				),
				thisWeekAvgHR: avg(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} AND ${activities.averageHeartRate} IS NOT NULL THEN ${activities.averageHeartRate} ELSE NULL END`,
				),
				thisWeekFeeling: avg(
					sql`CASE WHEN ${activities.startDateLocal} >= ${startOfThisWeek} THEN ${activities.feeling} ELSE NULL END`,
				),
				lastMonthFeeling: avg(
					sql`CASE WHEN ${activities.startDateLocal} >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)} THEN ${activities.feeling} ELSE NULL END`,
				),
			})
			.from(activities)
			.where(
				and(
					eq(activities.userId, userId),
					inArray(activities.sportType, runningTypes),
				),
			);

		const result = stats[0];
		const thisWeekKm = (Number(result.thisWeekKm) || 0) / 1000;
		const prevWeekKm = (Number(result.prevWeekKm) || 0) / 1000;
		const last7DaysKm = (Number(result.last7DaysKm) || 0) / 1000;
		const prev7DaysKm = (Number(result.prev7DaysKm) || 0) / 1000;

		const weekPercentChange =
			prevWeekKm === 0 ? 0 : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;
		const sevenDayPercentChange =
			prev7DaysKm === 0 ? 0 : ((last7DaysKm - prev7DaysKm) / prev7DaysKm) * 100;

		const fourWeeksAgo = new Date(startOfThisWeek);
		fourWeeksAgo.setUTCDate(fourWeeksAgo.getUTCDate() - 7 * 4);

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
					lte(activities.startDateLocal, startOfThisWeek),
				),
			);

		const pastWeekDistances: number[] = [];
		for (let w = 1; w <= 4; w++) {
			const weekStart = new Date(startOfThisWeek);
			weekStart.setUTCDate(weekStart.getUTCDate() - 7 * w);
			const weekCutoff = new Date(
				weekStart.getTime() + weekProgressFraction * msInWeek,
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
				? pastWeekDistances.reduce((a, b) => a + b, 0) /
					pastWeekDistances.length
				: 0;

		const weightedWeekPercentChange =
			avgKmByThisPointInWeek === 0
				? 0
				: ((thisWeekKm - avgKmByThisPointInWeek) / avgKmByThisPointInWeek) *
					100;

		const weeklyRunData = await c.env.db
			.select({
				weekStart: sql<string>`DATE_TRUNC('week', ${activities.startDateLocal})::date`,
				totalDistance: sum(activities.distance),
			})
			.from(activities)
			.where(
				and(
					eq(activities.userId, userId),
					inArray(activities.sportType, runningTypes),
					gte(activities.startDateLocal, eightWeeksAgo),
				),
			)
			.groupBy(sql`DATE_TRUNC('week', ${activities.startDateLocal})`)
			.orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);

		const otherTypes = OTHER_SPORT_TYPES as unknown as string[];

		const otherActivitiesRaw = await c.env.db
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
					gte(activities.startDateLocal, eightWeeksAgo),
				),
			)
			.groupBy(
				sql`DATE_TRUNC('week', ${activities.startDateLocal})`,
				activities.sportType,
			)
			.orderBy(sql`DATE_TRUNC('week', ${activities.startDateLocal}) ASC`);
		const graphData = [];
		for (let i = 8; i >= 0; i--) {
			const weekStart = new Date(startOfThisWeek);
			weekStart.setUTCDate(weekStart.getUTCDate() - 7 * i);
			const dateStr = weekStart.toISOString().split("T")[0];
			const runMatch = weeklyRunData.find((w) => w.weekStart === dateStr);
			const runKm = runMatch ? (Number(runMatch.totalDistance) || 0) / 1000 : 0;

			const otherRows = otherActivitiesRaw.filter(
				(w) => w.weekStart === dateStr,
			);

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

		const longTermStats = await c.env.db
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
					gte(activities.startDateLocal, eightWeeksAgo),
				),
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
	},
);

const weekStartParamSchema = z.object({ weekStart: z.string() });

dashboardRouter.get(
	"/week/:weekStart",
	describeRoute({
		description: "Get detailed stats for a specific week",
		responses: {
			200: {
				description: "Week detail",
				content: {
					"application/json": { schema: resolver(WeekDetailResponseSchema) },
				},
			},
			400: {
				description: "Invalid weekStart",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("param", weekStartParamSchema),
	async (c) => {
		const userId = c.get("userId");

		const weekStartParam = c.req.param("weekStart");
		const weekStart = new Date(weekStartParam);
		if (isNaN(weekStart.getTime())) {
			return c.json(
				{
					error:
						"Invalid weekStart date. Use ISO format: YYYY-MM-DD (Monday of the target week)",
				},
				400,
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

		const runningTypes = RUNNING_SPORT_TYPES as unknown as string[];
		const otherTypes = OTHER_SPORT_TYPES as unknown as string[];

		const runningStatsRaw = await c.env.db
			.select({
				thisWeekDistance: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} THEN ${activities.distance} ELSE 0 END`,
				),
				thisWeekElevation: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} THEN ${activities.totalElevationGain} ELSE 0 END`,
				),
				thisWeekMovingTime: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} THEN ${activities.movingTime} ELSE 0 END`,
				),
				thisWeekAvgHR: avg(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} AND ${activities.averageHeartRate} IS NOT NULL THEN ${activities.averageHeartRate} ELSE NULL END`,
				),
				thisWeekFeeling: avg(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} THEN ${activities.feeling} ELSE NULL END`,
				),
				thisWeekSessions: count(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} THEN 1 ELSE NULL END`,
				),
				thisWeekIndoor: count(
					sql`CASE WHEN ${activities.startDateLocal} >= ${weekStart} AND ${activities.startDateLocal} < ${weekEnd} AND ${activities.indoor} = true THEN 1 ELSE NULL END`,
				),

				prevWeekDistance: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${prevWeekStart} AND ${activities.startDateLocal} < ${prevWeekEnd} THEN ${activities.distance} ELSE 0 END`,
				),

				monthAgoDistance: sum(
					sql`CASE WHEN ${activities.startDateLocal} >= ${monthAgoWeekStart} AND ${activities.startDateLocal} < ${monthAgoWeekEnd} THEN ${activities.distance} ELSE 0 END`,
				),
			})
			.from(activities)
			.where(
				and(
					eq(activities.userId, userId),
					inArray(activities.sportType, runningTypes),
					gte(activities.startDateLocal, monthAgoWeekStart),
					lte(activities.startDateLocal, weekEnd),
				),
			);

		const rs = runningStatsRaw[0];

		const thisWeekKm = (Number(rs.thisWeekDistance) || 0) / 1000;
		const prevWeekKm = (Number(rs.prevWeekDistance) || 0) / 1000;
		const monthAgoKm = (Number(rs.monthAgoDistance) || 0) / 1000;
		const thisWeekMovingTimeSec = Number(rs.thisWeekMovingTime) || 0;

		const percentChangeVsPrevWeek =
			prevWeekKm === 0 ? null : ((thisWeekKm - prevWeekKm) / prevWeekKm) * 100;

		const percentChangeVsSameWeek1MonthAgo =
			monthAgoKm === 0 ? null : ((thisWeekKm - monthAgoKm) / monthAgoKm) * 100;

		const avgPaceMinPerKm =
			thisWeekKm > 0 && thisWeekMovingTimeSec > 0
				? thisWeekMovingTimeSec / 60 / thisWeekKm
				: null;

		const thisWeekSessions = Number(rs.thisWeekSessions) || 0;
		const thisWeekIndoor = Number(rs.thisWeekIndoor) || 0;
		const thisWeekOutdoor = thisWeekSessions - thisWeekIndoor;

		const weekActivities = await c.env.db
			.select({
				trainingType: activities.trainingType,
			})
			.from(activities)
			.where(
				and(
					eq(activities.userId, userId),
					inArray(activities.sportType, runningTypes),
					gte(activities.startDateLocal, weekStart),
					lte(activities.startDateLocal, weekEnd),
				),
			);

		const trainingTypeBreakdown: Record<string, number> = {};
		for (const { trainingType } of weekActivities) {
			if (!trainingType) continue;
			trainingTypeBreakdown[trainingType] =
				(trainingTypeBreakdown[trainingType] ?? 0) + 1;
		}

		const intervalCount = weekActivities.filter(
			(a) =>
				a.trainingType &&
				(INTERVAL_TRAINING_TYPES as readonly string[]).includes(a.trainingType),
		).length;

		const otherActivitiesRaw = await c.env.db
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

		let otherCombinedKm = 0;
		const otherActivities = otherActivitiesRaw.map((row) => {
			const sport = row.sportType;
			const km = isTimeBased(sport)
				? ellipticalTimeToMetres(Number(row.totalMovingTime) || 0) / 1000
				: (Number(row.totalDistance) || 0) / 1000;
			otherCombinedKm += km;
			return {
				sportType: sport,
				km,
				movingTimeSec: Number(row.totalMovingTime) || 0,
			};
		});

		return c.json({
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
			intervals: {
				count: intervalCount,
			},
			otherActivities: {
				combinedKm: otherCombinedKm,
				breakdown: otherActivities,
			},
		});
	},
);

export default dashboardRouter;
