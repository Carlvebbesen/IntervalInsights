import { Hono } from "hono";
import { TStravaEnv } from "../types/IRouters";
import { activities } from "../schema";
import { eq,inArray,and } from "drizzle-orm";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { getProposedPaceForStructure, triggerCompleteAnalysis } from "../services.ts/analysis_service";
import z from "zod";
import { workoutBlock } from "../agent/initial_analysis_agent";
import { zValidator } from "@hono/zod-validator";
import { IntervalGroup } from "../types/IintervalGroup";


const agentsRouter = new Hono<TStravaEnv>();
agentsRouter.use('*', stravaMiddleware);

agentsRouter.get("/pending", async (c)=>{
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
  return c.json(result, 200);
});

agentsRouter.post("/start-complete-analysis", async (c) => {
  try {
    const body = await c.req.json<{ activityId: number;stravaId: number; notes: string;groups?: IntervalGroup[]; }>();
    const { activityId, notes, stravaId, groups } = body;
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
      groups??[],

    );
    return c.json({ success: true, message: "Analysis Started successfully" }, 200);
  } catch (error) {
    console.error("Error starting analysis:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});


const paceRequestSchema = z.object({
  structure: z.array(workoutBlock),
});

agentsRouter.post(
  "/proposed-pace",
  zValidator("json", paceRequestSchema),
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
