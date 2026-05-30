import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as eventController from "../controllers/event_controller";
import { eventStatusEnum, eventTypeEnum } from "../schema";
import {
  DeleteEventResponseSchema,
  ErrorSchema,
  EventListItemSchema,
  EventListResponseSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const eventsRouter = new Hono<TGlobalEnv>();

const listQuerySchema = z.object({
  status: z.enum(eventStatusEnum.enumValues).optional(),
  eventType: z.enum(eventTypeEnum.enumValues).optional(),
});

eventsRouter.get(
  "/",
  describeRoute({
    description:
      "List every event for the authenticated user, newest occurrence first. Optional filters: `status` (active/resolved), `eventType`.",
    responses: {
      200: {
        description: "All events for the user",
        content: { "application/json": { schema: resolver(EventListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", listQuerySchema),
  async (c) => {
    const events = await eventController.listEvents(
      c.env.db,
      c.get("userId"),
      c.req.valid("query"),
    );
    return c.json({ events });
  },
);

const createEventSchema = z.object({
  activityId: z.number().int().positive(),
  eventType: z.enum(eventTypeEnum.enumValues),
  bodyLocation: z.string().min(1).nullable().optional(),
  description: z.string().min(1),
  // ISO-8601 timestamp. Defaults to the activity's start date when omitted.
  startTime: z.string().datetime().optional(),
  status: z.enum(eventStatusEnum.enumValues).optional(),
});

eventsRouter.post(
  "/",
  describeRoute({
    description:
      "Create a new event and link it to one of the user's activities. `startTime` defaults to the activity's start date when omitted.",
    responses: {
      201: {
        description: "Created event",
        content: { "application/json": { schema: resolver(EventListItemSchema) } },
      },
      404: {
        description: "Activity not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", createEventSchema),
  async (c) => {
    const created = await eventController.createEvent(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(created, 201);
  },
);

const eventIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateEventSchema = z
  .object({
    eventType: z.enum(eventTypeEnum.enumValues).optional(),
    bodyLocation: z.string().min(1).nullable().optional(),
    description: z.string().min(1).optional(),
    status: z.enum(eventStatusEnum.enumValues).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

eventsRouter.patch(
  "/:id",
  describeRoute({
    description:
      "Edit an event (description, body location, type, status). Toggling `status` keeps `resolvedAt` in sync.",
    responses: {
      200: {
        description: "Updated event",
        content: { "application/json": { schema: resolver(EventListItemSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", eventIdParamSchema),
  validator("json", updateEventSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const updated = await eventController.updateEvent(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

const deleteEventQuerySchema = z.object({
  activityId: z.coerce.number().int().positive(),
});

eventsRouter.delete(
  "/:id",
  describeRoute({
    description:
      "Unlink an event from the given activity. When that was the event's only linked activity, the event itself is deleted.",
    responses: {
      200: {
        description: "Unlink result",
        content: { "application/json": { schema: resolver(DeleteEventResponseSchema) } },
      },
      404: {
        description: "Event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", eventIdParamSchema),
  validator("query", deleteEventQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { activityId } = c.req.valid("query");
    const result = await eventController.unlinkEvent(c.env.db, c.get("userId"), id, activityId);
    return c.json(result);
  },
);

export default eventsRouter;
