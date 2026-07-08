import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import {
  ErrorSchema,
  HeartRateAnalysisRequestSchema,
  HeartRateAnalysisResponseSchema,
} from "../schemas/api_schemas";
import { getHeartRateAnalysis } from "../services/heart_rate_analysis_service";
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

export default heartRateRouter;
