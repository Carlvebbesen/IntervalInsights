import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import * as activityController from "../controllers/activity_controller";
import { stravaMiddleware } from "../middlewares/strava_middleware";
import { eventTypeEnum, trainingTypeEnum } from "../schema";
import {
  ActivityListResponseSchema,
  ActivitySchema,
  ActivityStreamsSchema,
  AssignGearSchema,
  EditorStateRequestSchema,
  EditorStateResponseSchema,
  EditSegmentsRequestSchema,
  IntervalSegmentSchema,
  SegmentsResponseSchema,
  SplitMetricSchema,
  StravaLapSchema,
} from "../schemas/api_schemas";
import { errJson, okJson } from "../schemas/route_helpers";
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

activitiesRouter.post(
  "/",
  describeRoute({
    description: "List activities for the authenticated user",
    responses: {
      200: okJson(ActivityListResponseSchema, "Paginated activity list"),
      500: errJson("Internal server error"),
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
      200: okJson(ActivitySchema, "Activity"),
      400: errJson("Invalid activity ID"),
      404: errJson("Activity not found"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const activity = await activityController.getActivityDetail(
      c.env.db,
      c.get("userId"),
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
      200: okJson(
        z.object({ intervalSegments: z.array(IntervalSegmentSchema) }),
        "Interval segments",
      ),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await activityController.getSegments(c.env.db, c.get("userId"), id);
    return c.json(result);
  },
);

// Editable activity-metadata fields for PATCH /:id.
const activityMetadataSchema = z.object({
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  notes: z.string().nullable().optional(),
  feeling: z.number().nullable().optional(),
});

// PATCH /:id — preferred update route.
activitiesRouter.patch(
  "/:id",
  describeRoute({
    description: "Update activity metadata (trainingType, notes, feeling)",
    responses: {
      200: okJson(ActivitySchema, "Updated activity"),
      400: errJson("Bad request"),
      404: errJson("Activity not found"),
      500: errJson("Internal server error"),
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

activitiesRouter.patch(
  "/:id/gear",
  describeRoute({
    description: "Assign (or clear with gearId=null) the local shoe on an activity.",
    responses: {
      200: okJson(ActivitySchema, "Updated activity"),
      404: errJson("Activity not found"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  validator("json", AssignGearSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { gearId } = c.req.valid("json");
    const updated = await activityController.assignGear(c.env.db, c.get("userId"), id, gearId);
    return c.json(updated);
  },
);

const stravaActivitiesRouter = new Hono<TStravaEnv>();
stravaActivitiesRouter.use("*", stravaMiddleware);

// intervals.icu-preferred (falls back to Strava); on the global router so
// intervals-only users (no Strava link) can reach it. Path id is the INTERNAL id.
activitiesRouter.get(
  "/:id/laps",
  describeRoute({
    description: "Get laps/intervals for an activity (intervals.icu-preferred, Strava fallback)",
    responses: {
      200: okJson(z.object({ laps: z.array(StravaLapSchema) }), "Activity laps"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const laps = await activityController.getLaps(c.env.db, c.get("userId"), id);
    return c.json({ laps });
  },
);

activitiesRouter.get(
  "/:id/splits",
  describeRoute({
    description:
      "Get metric splits for an activity (Strava; empty for intervals-only — app derives)",
    responses: {
      200: okJson(z.object({ splits_metric: z.array(SplitMetricSchema) }), "Activity splits"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const splits = await activityController.getSplits(c.env.db, c.get("userId"), id);
    return c.json({ splits_metric: splits });
  },
);

activitiesRouter.get(
  "/:id/streams",
  describeRoute({
    description:
      "Time-series streams (time, distance, altitude, cadence, velocity, heartrate when consented), intervals.icu-preferred with Strava fallback. Path id is the INTERNAL id.",
    responses: {
      200: okJson(ActivityStreamsSchema, "Activity stream data"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const streams = await activityController.getStreams(c.env.db, c.get("userId"), id);
    return c.json(streams);
  },
);

activitiesRouter.put(
  "/:id/segments",
  describeRoute({
    description:
      "Replace all interval segments for an activity (post-analysis edit). Recomputes actual stats from intervals.icu-preferred streams (Strava fallback) over the supplied boundaries.",
    responses: {
      200: okJson(SegmentsResponseSchema, "Updated interval segments"),
      400: errJson("Bad request"),
      404: errJson("Activity not found"),
      500: errJson("Internal server error"),
    },
  }),
  validator("param", activityIdParamSchema),
  validator("json", EditSegmentsRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { segments } = c.req.valid("json");
    const result = await activityController.editSegments(c.env.db, c.get("userId"), id, segments);
    return c.json(result);
  },
);

stravaActivitiesRouter.post(
  "/:id/editor-state",
  describeRoute({
    description:
      "Hydrate the unified pace/segment editor in ONE call. Pass `structure` (WorkoutSet[]) on initial load to compute proposed paces + derive segments, or `sets` (paced ExpandedIntervalSet[]) to re-derive segments after a structural edit (add/remove/delete a rep) — the paces flow through verbatim. The returned `sets` drive the derived `segments`, so the pace view and segment list cannot diverge. Replaces the separate /proposed-pace + /draft-segments round-trips. Read-only.",
    responses: {
      200: okJson(
        EditorStateResponseSchema,
        "Paced rep-list + derived segments (+ streams for the chart)",
      ),
      400: errJson("Bad request"),
      404: errJson("Activity not found"),
    },
  }),
  validator("param", activityIdParamSchema),
  validator("json", EditorStateRequestSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await activityController.getEditorState(
      c.env.db,
      c.get("userId"),
      c.get("stravaAccessToken"),
      id,
      body,
      c.var.logger,
    );
    return c.json(result);
  },
);

export { stravaActivitiesRouter };
export default activitiesRouter;
