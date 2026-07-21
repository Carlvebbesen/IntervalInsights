import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as analysisController from "../controllers/analysis_controller";
import {
  ANALYSIS_START_DAILY_MAX,
  ANALYSIS_START_QUOTA,
  dailyQuota,
  PARSE_INTERVALS_DAILY_MAX,
  PARSE_INTERVALS_QUOTA,
} from "../middlewares/quota_middleware";
import { softStravaMiddleware, stravaMiddleware } from "../middlewares/strava_middleware";
import { analysisStatusEnum, trainingTypeEnum } from "../schema/enums";
import {
  EditedSegmentSchema,
  ErrorSchema,
  ExpandedIntervalSetSchema,
  PendingActivitySchema,
  ProposedPaceResponseSchema,
} from "../schemas/api_schemas";
import type { TStravaEnv } from "../types/IRouters";

const agentsRouter = new Hono<TStravaEnv>();

agentsRouter.get(
  "/pending",
  softStravaMiddleware,
  describeRoute({
    description: "Get activities pending analysis (re-queues skipped_inactive and error rows).",
    responses: {
      200: {
        description: "Pending activities",
        content: { "application/json": { schema: resolver(z.array(PendingActivitySchema)) } },
      },
    },
  }),
  async (c) => {
    const result = await analysisController.getPending(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
    );
    return c.json(result, 200);
  },
);

const startAnalysisSchema = z.object({
  activityId: z.number(),
  stravaActivityId: z.number().nullish(),
  force: z.boolean().optional(),
});

agentsRouter.post(
  "/start-analysis",
  stravaMiddleware,
  dailyQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX),
  describeRoute({
    description: "Start the LangGraph analysis pipeline for an activity",
    responses: {
      200: {
        description:
          "Analysis started. `analysisStatus` is the activity's status after the claim attempt — `ongoing_init` when this call started a run, otherwise the status that blocked it (a run already in flight, or an already-finished activity).",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                success: z.boolean(),
                analysisStatus: z.enum(analysisStatusEnum.enumValues),
              }),
            ),
          },
        },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", startAnalysisSchema),
  async (c) => {
    const { activityId, force } = c.req.valid("json");
    const result = await analysisController.startActivityAnalysis(
      c.env.db,
      c.get("stravaAccessToken"),
      activityId,
      c.get("userId"),
      force ?? false,
    );
    return c.json(result, 200);
  },
);

const resumeAnalysisSchema = z.object({
  activityId: z.number(),
  notes: z.string().max(2000),
  sets: z.array(ExpandedIntervalSetSchema).optional(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  feeling: z.number().int().min(1).max(5).nullable().optional(),
  editedSegments: z.array(EditedSegmentSchema).optional(),
});

agentsRouter.post(
  "/resume-analysis",
  stravaMiddleware,
  dailyQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX),
  describeRoute({
    description: "Resume the LangGraph analysis pipeline after user input",
    responses: {
      200: {
        description: "Analysis resumed",
        content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", resumeAnalysisSchema),
  async (c) => {
    const result = await analysisController.resumeActivityAnalysis(
      c.env.db,
      c.get("stravaAccessToken"),
      c.get("userId"),
      c.req.valid("json"),
      c.var.logger,
    );
    return c.json(result, 200);
  },
);

const autoCompleteSchema = z.object({
  activityId: z.number(),
});

agentsRouter.post(
  "/auto-complete",
  stravaMiddleware,
  dailyQuota(ANALYSIS_START_QUOTA, ANALYSIS_START_DAILY_MAX),
  describeRoute({
    description:
      "Quick-complete an activity paused at `initial`: resume with an empty payload (suggested gear + any text-declared paces), regardless of the user's review mode.",
    responses: {
      200: {
        description: "Analysis completed (or a raced concurrent resume already claimed it).",
        content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
      },
      400: {
        description: "Bad request (e.g. a structureless interval draft).",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      409: {
        description: "Activity is not in the `initial` (ready-to-complete) state.",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", autoCompleteSchema),
  async (c) => {
    const { activityId } = c.req.valid("json");
    const result = await analysisController.autoCompleteActivity(
      c.env.db,
      c.get("stravaAccessToken"),
      c.get("userId"),
      activityId,
      c.var.logger,
    );
    return c.json(result, 200);
  },
);

const parseIntervalsSchema = z.object({
  text: z.string().min(3).max(2000),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
});

agentsRouter.post(
  "/parse-intervals",
  dailyQuota(PARSE_INTERVALS_QUOTA, PARSE_INTERVALS_DAILY_MAX),
  describeRoute({
    description:
      "Parse a free-text workout description (e.g. '6x800m @ 3:45 with 90s rest') into ExpandedIntervalSet[] with proposed paces filled.",
    responses: {
      200: {
        description: "Parsed interval sets with proposed paces.",
        content: { "application/json": { schema: resolver(ProposedPaceResponseSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", parseIntervalsSchema),
  async (c) => {
    const { text, trainingType } = c.req.valid("json");
    const result = await analysisController.parseIntervals(
      c.env.db,
      c.get("userId"),
      text,
      trainingType ?? null,
      c.var.logger,
    );
    return c.json(result, 200);
  },
);

export default agentsRouter;
