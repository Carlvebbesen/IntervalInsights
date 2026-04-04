import { Hono } from "hono";
import { TStravaEnv } from "../types/IRouters";
import { activities } from "../schema";
import { eq,inArray,and } from "drizzle-orm";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { getProposedPaceForStructure, resumeAnalysis, startAnalysis } from "../services.ts/analysis_service";
import { TrainingType } from "../schema/enums";
import z from "zod";
import { workoutSet } from "../agent/initial_analysis_agent";
import { describeRoute, resolver, validator } from "hono-openapi";
import { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import { ErrorSchema, PendingActivitySchema } from "../schemas/api_schemas";


const agentsRouter = new Hono<TStravaEnv>();
agentsRouter.use('*', stravaMiddleware);

agentsRouter.get(
  "/pending",
  describeRoute({
    description: "Get activities pending analysis",
    responses: {
      200: { description: "Pending activities", content: { "application/json": { schema: resolver(z.array(PendingActivitySchema)) } } },
    },
  }),
  async (c)=>{
    const userId = c.get("userId");
    const result = await c.env.db
  .select({
    id: activities.id,
    stravaId: activities.stravaActivityId,
    trainingType: activities.trainingType,
    analysisStatus: activities.analysisStatus,
    draftAnalysisResult: activities.draftAnalysisResult,
    title: activities.title,
    notes: activities.notes,
    distance: activities.distance,
    movingTime: activities.movingTime,
    description: activities.description,
    indoor: activities.indoor,
  })
  .from(activities)
  .where(
    and(
      eq(activities.userId, userId),
      inArray(activities.analysisStatus, ["initial", "pending", "error"])
    )
  );
  const accessToken = c.get("stravaAccessToken");
  result
    .filter((activity) => activity.analysisStatus === "error")
    .forEach((errorActivity) =>
      startAnalysis(c.env.db, accessToken, errorActivity.id, errorActivity.stravaId, userId),
    );
  const pending = result.filter((activity )=> activity.analysisStatus !== "error" );
  return c.json(pending, 200);
});

const startCompleteAnalysisSchema = z.object({
  activityId: z.number(),
  stravaId: z.number(),
  notes: z.string(),
  sets: z.array(z.unknown()).optional(),
});

agentsRouter.post(
  "/start-complete-analysis",
  describeRoute({
    description: "Resume the complete analysis for an activity (alias for /resume-analysis)",
    responses: {
      200: { description: "Analysis started", content: { "application/json": { schema: resolver(z.object({ success: z.boolean(), message: z.string() })) } } },
      400: { description: "Bad request", content: { "application/json": { schema: resolver(ErrorSchema) } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: resolver(ErrorSchema) } } },
      500: { description: "Internal server error", content: { "application/json": { schema: resolver(ErrorSchema) } } },
    },
  }),
  validator("json", startCompleteAnalysisSchema),
  async (c) => {
    try {
      const { activityId, notes, sets } = c.req.valid("json");
      if (!activityId) {
        return c.json({ error: "Activity ID is required" }, 400);
      }
      const accessToken = c.get("stravaAccessToken");
      if (!accessToken) {
        return c.json({ error: "Access token missing from context" }, 401);
      }
      resumeAnalysis(
        c.env.db,
        accessToken,
        activityId,
        notes || "",
        (sets ?? []) as ExpandedIntervalSet[],
        null,
      );
      return c.json({ success: true, message: "Analysis started successfully" }, 200);
    } catch (error) {
      console.error("Error starting analysis:", error);
      return c.json({ error: "Internal Server Error" }, 500);
    }
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
      200: { description: "Analysis started", content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } } },
      400: { description: "Bad request", content: { "application/json": { schema: resolver(ErrorSchema) } } },
      500: { description: "Internal server error", content: { "application/json": { schema: resolver(ErrorSchema) } } },
    },
  }),
  validator("json", startAnalysisSchema),
  async (c) => {
    try {
      const { activityId, stravaActivityId } = c.req.valid("json");
      const userId = c.get("userId");
      const accessToken = c.get("stravaAccessToken");
      if (!accessToken) {
        return c.json({ error: "Access token missing" }, 400);
      }
      startAnalysis(c.env.db, accessToken, activityId, stravaActivityId, userId);
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Error starting analysis:", error);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  },
);

const resumeAnalysisSchema = z.object({
  activityId: z.number(),
  notes: z.string(),
  sets: z.array(z.unknown()).optional(),
  trainingType: z.string().nullable().optional(),
});

agentsRouter.post(
  "/resume-analysis",
  describeRoute({
    description: "Resume the LangGraph analysis pipeline after user input",
    responses: {
      200: { description: "Analysis resumed", content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } } },
      400: { description: "Bad request", content: { "application/json": { schema: resolver(ErrorSchema) } } },
      500: { description: "Internal server error", content: { "application/json": { schema: resolver(ErrorSchema) } } },
    },
  }),
  validator("json", resumeAnalysisSchema),
  async (c) => {
    try {
      const { activityId, notes, sets, trainingType } = c.req.valid("json");
      const accessToken = c.get("stravaAccessToken");
      if (!accessToken) {
        return c.json({ error: "Access token missing" }, 400);
      }
      resumeAnalysis(
        c.env.db,
        accessToken,
        activityId,
        notes ?? "",
        (sets ?? []) as ExpandedIntervalSet[],
        (trainingType as TrainingType | null) ?? null,
      );
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Error resuming analysis:", error);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  },
);

const paceRequestSchema = z.object({
  structure: z.array(workoutSet),
});

agentsRouter.post(
  "/proposed-pace",
  describeRoute({
    description: "Get proposed paces for an interval structure",
    responses: {
      200: { description: "Proposed paces", content: { "application/json": { schema: resolver(z.unknown()) } } },
      500: { description: "Internal server error", content: { "application/json": { schema: resolver(ErrorSchema) } } },
    },
  }),
  validator("json", paceRequestSchema),
  async (c) => {
  const user = c.get("userId");
  const data = c.req.valid("json");
  const { structure } = data;
  if (!structure || structure.length === 0) {
    return c.json({ proposed_paces: null });
  }
    try {
      const proposedPaces = await getProposedPaceForStructure(c.env.db, user, structure);
      return c.json(
        proposedPaces 
      );
    } catch (error) {
      console.error("Error calculating proposed pace:", error);
      return c.json({ error: "Failed to calculate pace" }, 500);
    }
  }
);


export default agentsRouter;
