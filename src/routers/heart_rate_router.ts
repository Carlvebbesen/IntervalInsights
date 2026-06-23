import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  ErrorSchema,
  HeartRateAnalysisRequestSchema,
  HeartRateAnalysisResponseSchema,
  HrZoneSchema,
} from "../schemas/api_schemas";
import { getHeartRateAnalysis, getHrZones } from "../services/heart_rate_analysis_service";
import type { TGlobalEnv } from "../types/IRouters";

const heartRateRouter = new Hono<TGlobalEnv>();

heartRateRouter.get(
  "/zones",
  describeRoute({
    description:
      "The athlete's HR zone bands from intervals.icu (empty when intervals.icu isn't linked). Used by the app to compute per-lap time-in-zone client-side.",
    responses: {
      200: {
        description: "HR zone bands",
        content: {
          "application/json": { schema: resolver(z.object({ zones: z.array(HrZoneSchema) })) },
        },
      },
    },
  }),
  async (c) => {
    const zones = await getHrZones(c.get("clerkUserId"), c.var.logger);
    return c.json({ zones });
  },
);

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
      c.get("clerkUserId"),
      c.req.valid("json"),
      c.var.logger,
    );
    return c.json(result);
  },
);

export default heartRateRouter;
