import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { workoutSet } from "../agent/initial_analysis_agent";
import * as analysisController from "../controllers/analysis_controller";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { trainingTypeEnum } from "../schema/enums";
import {
  ErrorSchema,
  ExpandedIntervalSetSchema,
  PendingActivitySchema,
  ProposedPaceResponseSchema,
} from "../schemas/api_schemas";
import type { TStravaEnv } from "../types/IRouters";

const agentsRouter = new Hono<TStravaEnv>();
agentsRouter.use("*", stravaMiddleware);

agentsRouter.get(
  "/pending",
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
  stravaActivityId: z.number(),
});

agentsRouter.post(
  "/start-analysis",
  describeRoute({
    description: "Start the LangGraph analysis pipeline for an activity",
    responses: {
      200: {
        description: "Analysis started",
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
  validator("json", startAnalysisSchema),
  async (c) => {
    const { activityId, stravaActivityId } = c.req.valid("json");
    const result = analysisController.startActivityAnalysis(
      c.env.db,
      c.get("stravaAccessToken"),
      activityId,
      stravaActivityId,
      c.get("userId"),
    );
    return c.json(result, 200);
  },
);

const resumeAnalysisSchema = z.object({
  activityId: z.number(),
  notes: z.string(),
  sets: z.array(ExpandedIntervalSetSchema).optional(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  feeling: z.number().int().min(1).max(5).nullable().optional(),
});

agentsRouter.post(
  "/resume-analysis",
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
      c.req.valid("json"),
      c.var.logger,
    );
    return c.json(result, 200);
  },
);

const paceRequestSchema = z.object({
  structure: z.array(workoutSet),
  activityId: z.number().optional(),
});

agentsRouter.post(
  "/proposed-pace",
  describeRoute({
    description: "Get proposed paces for an interval structure",
    responses: {
      200: {
        description:
          "Proposed paces — one ExpandedIntervalSet per workout set, in order. Empty array if no structure was provided.",
        content: { "application/json": { schema: resolver(ProposedPaceResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", paceRequestSchema),
  async (c) => {
    const { structure, activityId } = c.req.valid("json");
    const result = await analysisController.getProposedPace(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      c.get("stravaAccessToken"),
      structure,
      activityId,
      c.var.logger,
    );
    return c.json(result);
  },
);

const parseIntervalsSchema = z.object({
  text: z.string().min(3).max(2000),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
});

agentsRouter.post(
  "/parse-intervals",
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
      c.get("clerkUserId"),
      text,
      trainingType ?? null,
      c.var.logger,
    );
    return c.json(result, 200);
  },
);

export default agentsRouter;
