import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { runInBackground } from "../../background";
import {
  ANALYSIS_START_DAILY_MAX,
  ANALYSIS_START_QUOTA,
  tryConsumeQuota,
} from "../../middlewares/quota_middleware";
import {
  ErrorSchema,
  StravaSummaryActivitySchema,
  SyncResultSchema,
  SyncStartedSchema,
} from "../../schemas/api_schemas";
import { startAnalysis } from "../../services/analysis_service";
import { stravaApiService } from "../../services/strava_api_service";
import { listUnsyncedActivities, syncAllFromStrava } from "../../services/strava_link_service";
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

    return c.json(await listUnsyncedActivities(c.env.db, userId, accessToken, c.req.query()));
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
          // Per-activity circuit breaker: the import POST is 1 request, but each
          // id fans out to a background analysis (real model spend), so the cap
          // is counted here rather than as route middleware.
          if (
            !tryConsumeQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX, userId, c.var.logger)
          )
            return;
          runInBackground(
            "analysis.start",
            () => startAnalysis(c.env.db, accessToken, internalId, stravaActivityId, userId),
            { attributes: { "activity.id": internalId, "user.id": userId } },
          );
        },
      ),
    );
  },
);

stravaApiRouter.post(
  "/sync",
  describeRoute({
    description:
      "Master sync from Strava: backfill title + gear for the last 2 years (linking to existing activities or creating new ones), then fetch descriptions for activities missing one — throttled to respect Strava's rate limit. Runs in the background and returns immediately; progress and final counts are pushed over the SSE progress channel (kind `strava_master_sync`). Re-runnable; the completed event's `descriptionsRemaining` indicates work left for a subsequent run. Never triggers LLM analysis.",
    responses: {
      202: {
        description: "Sync started; follow progress on the SSE channel",
        content: {
          "application/json": { schema: resolver(SyncStartedSchema) },
        },
      },
      401: {
        description: "Missing Strava access token or user",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const accessToken = c.get("stravaAccessToken");
    const userId = c.get("userId");
    if (!accessToken || !userId) return c.json({ error: "Unauthorized" }, 401);
    const log = c.var.logger;
    runInBackground(
      "strava.master_sync",
      async () => {
        const start = performance.now();
        log.info({ userId }, "Strava master sync started");
        const result = await syncAllFromStrava(c.env, accessToken, { id: userId });
        log.info(
          { userId, durationMs: Math.round(performance.now() - start), ...result },
          "Strava master sync completed",
        );
      },
      { attributes: { "user.id": userId }, logger: log },
    );
    return c.json({ status: "started" as const }, 202);
  },
);

export default stravaApiRouter;
