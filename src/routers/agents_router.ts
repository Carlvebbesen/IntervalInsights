import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { workoutSet } from "../agent/initial_analysis_agent";
import { invokeParseIntervalsAgent } from "../agent/parse_intervals_agent";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { activities } from "../schema";
import { type TrainingType, trainingTypeEnum } from "../schema/enums";
import {
  ErrorSchema,
  ExpandedIntervalSetSchema,
  PendingActivitySchema,
  ProposedPaceResponseSchema,
} from "../schemas/api_schemas";
import { resumeAnalysis, startAnalysis } from "../services.ts/analysis_service";
import { getProposedPaceForStructure, getProposedPaceFromLaps } from "../services.ts/pace_service";
import { requeueStaleActivities } from "../services.ts/requeue_service";
import { stravaApiService } from "../services.ts/strava_api_service";
import type { TStravaEnv } from "../types/IRouters";

const agentsRouter = new Hono<TStravaEnv>();
agentsRouter.use("*", stravaMiddleware);

const PENDING_STATUSES = ["initial", "pending", "error"] as const;

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
    const userId = c.get("userId");
    const accessToken = c.get("stravaAccessToken");

    if (accessToken) {
      await requeueStaleActivities(c.env.db, userId, accessToken);
    }

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
        feeling: activities.feeling,
      })
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          inArray(activities.analysisStatus, [...PENDING_STATUSES]),
        ),
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
  sets: z.array(ExpandedIntervalSetSchema).optional(),
  trainingType: z.string().nullable().optional(),
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
    try {
      const { activityId, notes, sets, trainingType, feeling } = c.req.valid("json");
      const accessToken = c.get("stravaAccessToken");
      console.log(
        `[/resume-analysis activity=${activityId}] payload sets=${sets?.length ?? 0} (steps=${sets?.reduce((s, set) => s + set.steps.length, 0) ?? 0}) notes.len=${notes.length} trainingType=${trainingType ?? "null"} feeling=${feeling ?? "null"}`,
      );
      if (!accessToken) {
        return c.json({ error: "Access token missing" }, 400);
      }
      await resumeAnalysis(
        c.env.db,
        accessToken,
        activityId,
        notes ?? "",
        sets ?? [],
        (trainingType as TrainingType | null) ?? null,
        feeling ?? null,
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
        content: {
          "application/json": { schema: resolver(ProposedPaceResponseSchema) },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", paceRequestSchema),
  async (c) => {
    const user = c.get("userId");
    const accessToken = c.get("stravaAccessToken");
    const data = c.req.valid("json");
    const { structure, activityId } = data;
    const tag = `[/proposed-pace activity=${activityId ?? "none"}]`;
    console.log(
      `${tag} request: structureSets=${structure?.length ?? 0} hasAccessToken=${!!accessToken}`,
    );
    if (!structure || structure.length === 0) {
      console.log(`${tag} empty structure — returning []`);
      return c.json([]);
    }
    try {
      if (activityId) {
        const activity = await c.env.db.query.activities.findFirst({
          where: and(eq(activities.id, activityId), eq(activities.userId, user)),
          columns: { indoor: true, stravaActivityId: true },
        });
        console.log(
          `${tag} activity lookup: found=${!!activity} indoor=${activity?.indoor ?? "n/a"} stravaId=${activity?.stravaActivityId ?? "n/a"}`,
        );
        if (activity && !activity.indoor && accessToken) {
          try {
            const laps = await stravaApiService.getActivityLaps(
              accessToken,
              activity.stravaActivityId,
            );
            console.log(`${tag} fetched ${laps.length} laps from Strava`);
            const fromLaps = getProposedPaceFromLaps(laps, structure);
            if (fromLaps) {
              console.log(`${tag} returning pace from laps`);
              return c.json(fromLaps);
            }
            console.log(`${tag} lap-derivation returned null — falling back to history`);
          } catch (lapErr) {
            console.error(`${tag} Strava laps fetch failed — falling back to history:`, lapErr);
          }
        } else {
          console.log(
            `${tag} skipping lap-derivation (indoor=${activity?.indoor} hasActivity=${!!activity} hasToken=${!!accessToken}) — using history`,
          );
        }
      } else {
        console.log(`${tag} no activityId provided — using history`);
      }
      const proposedPaces = await getProposedPaceForStructure(
        c.env.db,
        user,
        c.get("clerkUserId"),
        structure,
      );
      console.log(`${tag} returning pace from history (sets=${proposedPaces.length})`);
      return c.json(proposedPaces);
    } catch (error) {
      console.error(`${tag} Error calculating proposed pace:`, error);
      return c.json({ error: "Failed to calculate pace" }, 500);
    }
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
        content: {
          "application/json": { schema: resolver(ProposedPaceResponseSchema) },
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
  validator("json", parseIntervalsSchema),
  async (c) => {
    const userId = c.get("userId");
    const { text, trainingType } = c.req.valid("json");
    try {
      const parsed = await invokeParseIntervalsAgent(text, trainingType ?? null);
      if (!parsed || parsed.sets.length === 0) {
        return c.json([], 200);
      }
      const proposed = await getProposedPaceForStructure(
        c.env.db,
        userId,
        c.get("clerkUserId"),
        parsed.sets,
      );
      return c.json(proposed, 200);
    } catch (error) {
      console.error("Error parsing intervals:", error);
      return c.json({ error: "Failed to parse intervals" }, 500);
    }
  },
);

export default agentsRouter;
