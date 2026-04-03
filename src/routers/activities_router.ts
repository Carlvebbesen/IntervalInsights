import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	ilike,
	isNotNull,
	or,
} from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { activities, intervalSegments, trainingTypeEnum } from "../schema";
import {
	ActivityListResponseSchema,
	ActivitySchema,
	ErrorSchema,
	GearStatsResponseSchema,
	IntervalSegmentSchema,
} from "../schemas/api_schemas";
import { stravaApiService } from "../services.ts/strava_api_service";
import type { TGlobalEnv, TStravaEnv } from "../types/IRouters";

const activitiesRouter = new Hono<TGlobalEnv>();
const PAGE_SIZE = 15;

const querySchema = z.object({
	page: z.coerce.number().min(1).default(1),
	search: z.string().optional(),
	distance: z.coerce.number().optional(),
	trainingType: z.enum(trainingTypeEnum.enumValues).optional(),
	intervalStructureId: z.coerce.number().int().positive().optional(),
});

activitiesRouter.get(
	"/",
	describeRoute({
		description: "List activities for the authenticated user",
		responses: {
			200: {
				description: "Paginated activity list",
				content: {
					"application/json": { schema: resolver(ActivityListResponseSchema) },
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("query", querySchema),
	async (c) => {
		try {
			const userId = c.get("userId");
			const { page, search, distance, trainingType, intervalStructureId } = c.req.valid("query");
			const filters = [];
			filters.push(eq(activities.userId, userId));
			filters.push(eq(activities.analysisStatus, "completed"));
			if (search) {
				filters.push(
					or(
						ilike(activities.title, `%${search}%`),
						ilike(activities.description, `%${search}%`),
					),
				);
			}
			if (trainingType) {
				filters.push(eq(activities.trainingType, trainingType as any));
			}
			if (distance) {
				if (!isNaN(distance)) {
					filters.push(gte(activities.distance, distance));
				}
			}
			if (intervalStructureId) {
				filters.push(eq(activities.intervalStructureId, intervalStructureId));
			}
			const result = await c.env.db
				.select()
				.from(activities)
				.where(and(...filters))
				.limit(PAGE_SIZE)
				.offset((page - 1) * PAGE_SIZE)
				.orderBy(desc(activities.startDateLocal));
			return c.json({
				data: result,
				meta: {
					page,
					pageSize: PAGE_SIZE,
					filterApplied: { search, trainingType, distance, intervalStructureId },
				},
			});
		} catch (error) {
			console.error("Error fetching activities:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

activitiesRouter.get(
	"/:id/segments",
	describeRoute({
		description: "Get interval segments for an activity",
		responses: {
			200: {
				description: "Interval segments",
				content: {
					"application/json": {
						schema: resolver(
							z.object({ intervalSegments: z.array(IntervalSegmentSchema) }),
						),
					},
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	async (c) => {
		try {
			const activityId = parseInt(c.req.param("id"));
			if (isNaN(activityId)) {
				return c.json({ error: "Invalid activity ID" }, 400);
			}
			const segments = await c.env.db
				.select()
				.from(intervalSegments)
				.where(eq(intervalSegments.activityId, activityId))
				.orderBy(asc(intervalSegments.segmentIndex));
			return c.json({ intervalSegments: segments });
		} catch (error) {
			console.error("Error fetching activity:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

const activityIdParamSchema = z.object({
	id: z.coerce.number().int().positive(),
});

const stravaActivitiesRouter = new Hono<TStravaEnv>();
stravaActivitiesRouter.use("*", stravaMiddleware);

stravaActivitiesRouter.get(
	"/gear/stats",
	describeRoute({
		description: "Get aggregated usage statistics for each shoe/gear item",
		responses: {
			200: {
				description: "Gear stats",
				content: {
					"application/json": { schema: resolver(GearStatsResponseSchema) },
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	async (c) => {
		try {
			const userId = c.get("userId");
			const accessToken = c.get("stravaAccessToken");

			const rows = await c.env.db
				.select({
					gearId: activities.gearId,
					gearName: activities.gearName,
					trainingType: activities.trainingType,
					count: count(),
				})
				.from(activities)
				.where(and(eq(activities.userId, userId), isNotNull(activities.gearId)))
				.groupBy(
					activities.gearId,
					activities.gearName,
					activities.trainingType,
				);

			const statsMap = new Map<
				string,
				{
					gearName: string;
					activityCount: number;
					trainingTypeCounts: Record<string, number>;
				}
			>();
			for (const row of rows) {
				const id = row.gearId as string;
				const rowCount = Number(row.count);
				const existing = statsMap.get(id);
				if (!existing) {
					statsMap.set(id, {
						gearName: row.gearName ?? "",
						activityCount: rowCount,
						trainingTypeCounts: row.trainingType
							? { [row.trainingType]: rowCount }
							: {},
					});
				} else {
					existing.activityCount += rowCount;
					if (row.trainingType) {
						existing.trainingTypeCounts[row.trainingType] =
							(existing.trainingTypeCounts[row.trainingType] ?? 0) + rowCount;
					}
				}
			}

			const gearIds = [...statsMap.keys()];
			const gearDetails = await Promise.all(
				gearIds.map((id) => stravaApiService.getGear(accessToken, id)),
			);

			const stats = gearDetails
				.filter((gear) => !gear.retired)
				.map((gear) => {
					const agg = statsMap.get(gear.id)!;
					return {
						gearId: gear.id,
						gearName: gear.name,
						activityCount: agg.activityCount,
						trainingTypeCounts: agg.trainingTypeCounts,
						distanceKm: Math.round((gear.distance / 1000) * 10) / 10,
					};
				});

			return c.json({ stats });
		} catch (error) {
			console.error("Error fetching gear stats:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

stravaActivitiesRouter.get(
	"/gear",
	describeRoute({
		description: "Get gear for the authenticated user from Strava",
		responses: {
			200: {
				description: "Gear list",
				content: {
					"application/json": {
						schema: resolver(z.object({ gear: z.array(z.unknown()) })),
					},
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	async (c) => {
		try {
			const userId = c.get("userId");
			const gearRows = await c.env.db
				.selectDistinct({ gearId: activities.gearId })
				.from(activities)
				.where(
					and(eq(activities.userId, userId), isNotNull(activities.gearId)),
				);

			const gearIds = gearRows.map((r) => r.gearId as string);
			const gear = await Promise.all(
				gearIds.map((id) =>
					stravaApiService.getGear(c.get("stravaAccessToken"), id),
				),
			);
			return c.json({ gear });
		} catch (error) {
			console.error("Error fetching gear:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

stravaActivitiesRouter.get(
	"/:id/laps",
	describeRoute({
		description: "Get Strava laps for an activity",
		responses: {
			200: {
				description: "Activity laps",
				content: {
					"application/json": {
						schema: resolver(z.object({ laps: z.array(z.unknown()) })),
					},
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("param", activityIdParamSchema),
	async (c) => {
		try {
			const { id } = c.req.valid("param");
			const laps = await stravaApiService.getActivityLaps(
				c.get("stravaAccessToken"),
				id,
			);
			return c.json({ laps });
		} catch (error) {
			console.error("Error fetching laps:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

stravaActivitiesRouter.get(
	"/:id/splits",
	describeRoute({
		description: "Get Strava metric splits for an activity",
		responses: {
			200: {
				description: "Activity splits",
				content: {
					"application/json": {
						schema: resolver(z.object({ splits_metric: z.array(z.unknown()) })),
					},
				},
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("param", activityIdParamSchema),
	async (c) => {
		try {
			const { id } = c.req.valid("param");
			const activity = await stravaApiService.getActivity(
				c.get("stravaAccessToken"),
				id,
			);
			return c.json({ splits_metric: activity.splits_metric ?? [] });
		} catch (error) {
			console.error("Error fetching splits:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

stravaActivitiesRouter.get(
	"/:id/heartrate",
	describeRoute({
		description: "Get heartrate stream for an activity",
		responses: {
			200: {
				description: "Heartrate stream data",
				content: { "application/json": { schema: resolver(z.unknown()) } },
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("param", activityIdParamSchema),
	async (c) => {
		try {
			const { id } = c.req.valid("param");
			const streams = await stravaApiService.getActivityStreams(
				c.get("stravaAccessToken"),
				id,
				["heartrate", "time", "distance"],
			);
			return c.json(streams);
		} catch (error) {
			console.error("Error fetching heartrate stream:", error);
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);

const updateActivitySchema = z.object({
	id: z.number(),
	trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
	notes: z.string().nullable().optional(),
	feeling: z.number().nullable().optional(),
});
activitiesRouter.post(
	"/update",
	describeRoute({
		description: "Update activity metadata (trainingType, notes, feeling)",
		responses: {
			200: {
				description: "Updated activity",
				content: { "application/json": { schema: resolver(ActivitySchema) } },
			},
			400: {
				description: "Bad request",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
			404: {
				description: "Activity not found",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
			500: {
				description: "Internal server error",
				content: { "application/json": { schema: resolver(ErrorSchema) } },
			},
		},
	}),
	validator("json", updateActivitySchema),
	async (c) => {
		try {
			const { id, ...data } = c.req.valid("json");
			const updateData = Object.fromEntries(
				Object.entries(data).filter(([_, value]) => value != null),
			);
			if (Object.keys(updateData).length === 0) {
				return c.json({ error: "No valid data provided to update" }, 400);
			}

			const userId = c.get("userId");
			const updated = await c.env.db
				.update(activities)
				.set(updateData)
				.where(and(eq(activities.id, id), eq(activities.userId, userId)))
				.returning();

			if (updated.length === 0) {
				return c.json({ error: "Activity not found or unauthorized" }, 404);
			}

			return c.json(updated[0]);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return c.json({ error: "Invalid input", details: error.errors }, 400);
			}
			return c.json({ error: "Internal Server Error" }, 500);
		}
	},
);
export { stravaActivitiesRouter };
export default activitiesRouter;
