import { Hono } from "hono";
import { TStravaEnv } from "../types/IRouters";
import { activities } from "../schema";
import { eq,inArray,and } from "drizzle-orm";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { getProposedPaceForStructure, triggerCompleteAnalysis, triggerInitialAnalysis } from "../services.ts/analysis_service";
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
  result.filter((activity )=> activity.analysisStatus === "error" ).forEach((errorActivity, index) => triggerInitialAnalysis(
c.env.db,
  c.get("stravaAccessToken"),
  errorActivity.stravaId,
  index,
  ));
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
    description: "Start a complete analysis for an activity",
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
    const { activityId, notes, stravaId, sets } = c.req.valid("json");
    if (!activityId) {
      return c.json({ error: "Activity ID is required" }, 400);
    }
    const accessToken = c.get("stravaAccessToken"); 
    
    if (!accessToken) {
      return c.json({ error: "Access token missing from context" }, 401);
    }
    triggerCompleteAnalysis(
      c.env.db,
      accessToken,
      activityId,
      stravaId,
      notes || "",
      (sets ?? []) as ExpandedIntervalSet[],

    );
    return c.json({ success: true, message: "Analysis Started successfully" }, 200);
  } catch (error) {
    console.error("Error starting analysis:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});


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
