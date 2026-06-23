import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as activityController from "../controllers/activity_controller";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { eventTypeEnum, trainingTypeEnum } from "../schema";
import {
  ActivityListResponseSchema,
  ActivitySchema,
  ActivityStreamsSchema,
  DraftSegmentsResponseSchema,
  EditSegmentsRequestSchema,
  ErrorSchema,
  GearStatsResponseSchema,
  IntervalSegmentSchema,
  PatchSegmentSchema,
  SegmentsResponseSchema,
  SplitMetricSchema,
  StravaLapSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv, TStravaEnv } from "../types/IRouters";

const activitiesRouter = new Hono<TGlobalEnv>();

const bodySchema = z.object({
  page: z.number().min(1).default(1),
  search: z.string().optional(),
  distance: z.number().optional(),
  trainingType: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
  intervalStructureId: z.number().int().positive().optional(),
  sportTypes: z.array(z.string()).optional(),
  signatures: z.array(z.string()).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  eventTypes: z.array(z.enum(eventTypeEnum.enumValues)).optional(),
  eventIds: z.array(z.number().int().positive()).optional(),
});

const activityIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const segmentParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  segmentId: z.coerce.number().int().positive(),
});

activitiesRouter.post(
  "/",
  describeRoute({
    description: "List activities for the authenticated user",
    responses: {
      200: {
        description: "Paginated activity list",
        content: { "application/json": { schema: resolver(ActivityListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", bodySchema),
  async (c) => {
    const result = await activityController.listActivities(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(result);
  },
);

activitiesRouter.get(
  "/:id",
  describeRoute({
    description: "Get full activity details (all stored columns) for a single activity",
    responses: {
      200: {
        description: "Activity",
        content: { "application/json": { schema: resolver(ActivitySchema) } },
      },
      400: {
        description: "Invalid activity ID",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Activity not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const activity = await activityController.getActivityDetail(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
      c.var.logger,
    );
    return c.json(activity);
  },
);

activitiesRouter.get(
  "/:id/segments",
  describeRoute({
    description: "Get interval segments for an activity",
    responses: {
      200: {
        description: "Interval segments",
        content: {
          "application/json": {
            schema: resolver(z.object({ intervalSegments: z.array(IntervalSegmentSchema) })),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await activityController.getSegments(c.env.db, c.get("clerkUserId"), id);
    return c.json(result);
  },
);

// Editable activity-metadata fields, shared by PATCH /:id and the deprecated POST /update.
const activityMetadataSchema = z.object({
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  notes: z.string().nullable().optional(),
  feeling: z.number().nullable().optional(),
});

// POST /update carries the id in the body; PATCH /:id takes it from the path.
const updateActivitySchema = activityMetadataSchema.extend({
  id: z.number(),
});

// PATCH /:id — preferred update route.
activitiesRouter.patch(
  "/:id",
  describeRoute({
    description: "Update activity metadata (trainingType, notes, feeling)",
    responses: {
      200: {
        description: "Updated activity",
        content: { "application/json": { schema: resolver(ActivitySchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Activity not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  validator("json", activityMetadataSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const updated = await activityController.updateMetadata(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

/**
 * @deprecated Use `PATCH /activity/:id` instead. Kept for older app versions that
 * send the activity id in the request body. Remove once all clients have migrated.
 */
activitiesRouter.post(
  "/update",
  describeRoute({
    description:
      "[DEPRECATED — use PATCH /activity/:id] Update activity metadata (trainingType, notes, feeling)",
    deprecated: true,
    responses: {
      200: {
        description: "Updated activity",
        content: { "application/json": { schema: resolver(ActivitySchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Activity not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", updateActivitySchema),
  async (c) => {
    const { id, ...data } = c.req.valid("json");
    const updated = await activityController.updateMetadata(c.env.db, c.get("userId"), id, data);
    return c.json(updated);
  },
);

const stravaActivitiesRouter = new Hono<TStravaEnv>();
stravaActivitiesRouter.use("*", stravaMiddleware);

stravaActivitiesRouter.get(
  "/gear/stats",
  describeRoute({
    description: "Get aggregated usage statistics for each shoe/gear item",
    responses: {
      200: {
        description: "Gear stats",
        content: { "application/json": { schema: resolver(GearStatsResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const result = await activityController.getGearStats(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
    );
    return c.json(result);
  },
);

// intervals.icu-preferred (falls back to Strava); on the global router so
// intervals-only users (no Strava link) can reach it. Path id is the INTERNAL id.
activitiesRouter.get(
  "/:id/laps",
  describeRoute({
    description: "Get laps/intervals for an activity (intervals.icu-preferred, Strava fallback)",
    responses: {
      200: {
        description: "Activity laps",
        content: {
          "application/json": { schema: resolver(z.object({ laps: z.array(StravaLapSchema) })) },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const laps = await activityController.getLaps(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
    );
    return c.json({ laps });
  },
);

activitiesRouter.get(
  "/:id/splits",
  describeRoute({
    description: "Get metric splits for an activity (Strava; empty for intervals-only — app derives)",
    responses: {
      200: {
        description: "Activity splits",
        content: {
          "application/json": {
            schema: resolver(z.object({ splits_metric: z.array(SplitMetricSchema) })),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const splits = await activityController.getSplits(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
    );
    return c.json({ splits_metric: splits });
  },
);

stravaActivitiesRouter.get(
  "/:id/heartrate",
  describeRoute({
    description: "Get heartrate stream for an activity",
    responses: {
      200: {
        description: "Heartrate stream data",
        content: { "application/json": { schema: resolver(z.unknown()) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const streams = await activityController.getHeartrateStream(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
      id,
    );
    return c.json(streams);
  },
);

activitiesRouter.get(
  "/:id/streams",
  describeRoute({
    description:
      "Time-series streams (time, distance, altitude, cadence, velocity, heartrate when consented), intervals.icu-preferred with Strava fallback. Path id is the INTERNAL id.",
    responses: {
      200: {
        description: "Activity stream data",
        content: { "application/json": { schema: resolver(ActivityStreamsSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const streams = await activityController.getStreams(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
    );
    return c.json(streams);
  },
);

stravaActivitiesRouter.get(
  "/:id/draft-segments",
  describeRoute({
    description:
      "Get the proposed draft segments + HR/pace streams for the visual segment editor (activity must be in 'initial' status).",
    responses: {
      200: {
        description: "Draft segments and streams",
        content: { "application/json": { schema: resolver(DraftSegmentsResponseSchema) } },
      },
      404: {
        description: "Activity not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await activityController.getDraftSegments(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
      id,
    );
    return c.json(result);
  },
);

activitiesRouter.put(
  "/:id/segments",
  describeRoute({
    description:
      "Replace all interval segments for an activity (post-analysis edit). Recomputes actual stats from intervals.icu-preferred streams (Strava fallback) over the supplied boundaries.",
    responses: {
      200: {
        description: "Updated interval segments",
        content: { "application/json": { schema: resolver(SegmentsResponseSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Activity not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", activityIdParamSchema),
  validator("json", EditSegmentsRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { segments } = c.req.valid("json");
    const result = await activityController.editSegments(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
      segments,
    );
    return c.json(result);
  },
);

activitiesRouter.patch(
  "/:id/segments/:segmentId",
  describeRoute({
    description:
      "Edit a single interval segment (post-analysis). Recomputes stats for the whole activity since boundaries are contiguous.",
    responses: {
      200: {
        description: "Updated interval segments",
        content: { "application/json": { schema: resolver(SegmentsResponseSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Activity or segment not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", segmentParamSchema),
  validator("json", PatchSegmentSchema),
  async (c) => {
    const { id, segmentId } = c.req.valid("param");
    const patch = c.req.valid("json");
    const result = await activityController.editSingleSegment(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      id,
      segmentId,
      patch,
    );
    return c.json(result);
  },
);

export { stravaActivitiesRouter };
export default activitiesRouter;
