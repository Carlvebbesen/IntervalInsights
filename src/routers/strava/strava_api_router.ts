import { and, eq, gte, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { activities } from "../../schema";
import {
  ErrorSchema,
  StravaSummaryActivitySchema,
  SyncResultSchema,
} from "../../schemas/api_schemas";
import { startAnalysis } from "../../services.ts/analysis_service";
import { stravaApiService } from "../../services.ts/strava_api_service";
import type { TStravaEnv } from "../../types/IRouters";

const stravaApiRouter = new Hono<TStravaEnv>();

const ListSyncQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});

const PostSyncBodySchema = z.object({
  ids: z.array(z.number()),
});

stravaApiRouter.get(
  "/sync/activities",
  describeRoute({
    description:
      "List the authenticated user's Strava activities (forwarded from Strava v3 /athlete/activities) and filter out activities already imported into our DB. Pagination is forwarded via `page` and `per_page`.",
    responses: {
      200: {
        description:
          "Strava SummaryActivity[] minus activities we have already synced for this user.",
        content: {
          "application/json": { schema: resolver(z.array(StravaSummaryActivitySchema)) },
        },
      },
      401: {
        description: "Missing Strava access token or user",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", ListSyncQuerySchema),
  async (c) => {
    const accessToken = c.get("stravaAccessToken");
    if (!accessToken) return c.json({ error: "Unauthorized" }, 401);

    const userId = c.get("userId");
    if (!userId) {
      c.var.logger.warn("no user found");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const baseQuery = c.req.query();
    const startPage = Number(baseQuery.page ?? "1");
    const MAX_PAGES_TO_SKIP = 10;

    for (let offset = 0; offset < MAX_PAGES_TO_SKIP; offset++) {
      const stravaActivities = await stravaApiService.listAthleteActivities(accessToken, {
        ...baseQuery,
        page: String(startPage + offset),
      });

      if (stravaActivities.length === 0) return c.json([]);

      const oldestDate = new Date(
        Math.min(...stravaActivities.map((a) => new Date(a.start_date).getTime())),
      );

      const existingInDb = await c.env.db
        .select({ stravaActivityId: activities.stravaActivityId })
        .from(activities)
        .where(
          and(
            eq(activities.userId, userId),
            gte(activities.startDateLocal, oldestDate),
            inArray(
              activities.stravaActivityId,
              stravaActivities.map((a) => a.id),
            ),
          ),
        );

      const syncedIds = new Set(existingInDb.map((a) => a.stravaActivityId));
      const filtered = stravaActivities.filter((a) => !syncedIds.has(a.id));

      if (filtered.length > 0) return c.json(filtered);
    }

    return c.json([]);
  },
);

stravaApiRouter.post(
  "sync/activities",
  describeRoute({
    description:
      "Import a list of Strava activity IDs into our DB. Each activity is fetched in detail, inserted (skipping conflicts), and queued for LangGraph analysis.",
    responses: {
      200: {
        description: "Per-activity sync result",
        content: {
          "application/json": { schema: resolver(z.array(SyncResultSchema)) },
        },
      },
      401: {
        description: "Missing Strava access token or user",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", PostSyncBodySchema),
  async (c) => {
    const accessToken = c.get("stravaAccessToken");
    const userId = c.get("userId");
    if (!accessToken || !userId) return c.json({ error: "Unauthorized" }, 401);
    const { ids } = c.req.valid("json");
    return c.json(
      await stravaApiService.syncStravaActivities(
        accessToken,
        userId,
        ids,
        c.env.db,
        (internalId, stravaActivityId) => {
          startAnalysis(c.env.db, accessToken, internalId, stravaActivityId, userId);
        },
      ),
    );
  },
);

export default stravaApiRouter;
