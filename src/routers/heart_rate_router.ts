import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { runInBackground } from "../background";
import { AppError } from "../error";
import { SyncStartedSchema } from "../schemas/activity_schemas";
import {
  ErrorSchema,
  HeartRateAnalysisRequestSchema,
  HeartRateAnalysisResponseSchema,
} from "../schemas/api_schemas";
import { getHeartRateAnalysis } from "../services/heart_rate_analysis_service";
import { userHasHeartRateConsent } from "../services/heart_rate_consent_service";
import { isHrBackfillRunning, runHrBackfill } from "../services/hr_backfill_service";
import type { TGlobalEnv } from "../types/IRouters";

const heartRateRouter = new Hono<TGlobalEnv>();

heartRateRouter.post(
  "/analysis",
  describeRoute({
    description:
      "Heart-rate analysis series for the filtered set of the user's activities. Always HTTP 200 with a `status`-discriminated body: `ok` (top-level `points` + `zones` + `summaries`), `no_data` (filter matched nothing), or `not_linked` (intervals.icu not connected — zones come from there). Each point carries avg/max/median/mode HR; `intervalsOnly` restricts every metric to the work intervals. Returns 403 if the user has not enabled heart-rate processing.",
    responses: {
      200: {
        description: "Discriminated heart-rate analysis result",
        content: {
          "application/json": { schema: resolver(HeartRateAnalysisResponseSchema) },
        },
      },
      403: {
        description: "Heart-rate processing not enabled for this account",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", HeartRateAnalysisRequestSchema),
  async (c) => {
    const result = await getHeartRateAnalysis(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
      c.var.logger,
    );
    return c.json(result);
  },
);

heartRateRouter.post(
  "/backfill",
  describeRoute({
    description:
      "Start a background heart-rate backfill for the authenticated user: repairs the hasHeartrate flag on intervals.icu-sourced rows, re-fetches lost Strava HR summaries, and computes missing HR stream stats. Requires heart-rate processing consent. Fire-and-forget: returns 202 immediately and reports progress over the SSE progress channel as sync events with kind 'hr_backfill' (started -> progress {done,total} every 25 rows -> completed, one of hr_backfill_completed{computed} / _more{computed,remaining} / _rate_limited(+retryAt) / _up_to_date). 403 if consent is off; 409 if a backfill is already running for this user.",
    responses: {
      202: {
        description: "Backfill started",
        content: { "application/json": { schema: resolver(SyncStartedSchema) } },
      },
      403: {
        description: "Heart-rate processing not enabled",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      409: {
        description: "A backfill is already running",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    if (!(await userHasHeartRateConsent(c.env.db, userId)))
      throw new AppError(403, "Heart-rate processing not enabled for this account");
    if (isHrBackfillRunning(userId))
      throw new AppError(409, "A heart-rate backfill is already running");
    runInBackground("heartRate.backfill", () => runHrBackfill(c.env, userId, c.var.logger), {
      logger: c.var.logger,
    });
    return c.json({ status: "started" as const }, 202);
  },
);

export default heartRateRouter;
