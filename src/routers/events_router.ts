import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as eventController from "../controllers/event_controller";
import { eventStatusEnum, eventTypeEnum, noteTrendEnum } from "../schema";
import {
  DeleteEventNoteResponseSchema,
  DeleteEventResponseSchema,
  ErrorSchema,
  EventDetailSchema,
  EventListItemSchema,
  EventListResponseSchema,
  EventNoteSchema,
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
      "List every event for the authenticated user, newest occurrence first. Each item carries its anchor note (canonical summary) and latest note. Optional filters: `status` (active/resolved), `eventType`.",
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

const eventIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

eventsRouter.get(
  "/:id",
  describeRoute({
    description:
      "Full detail for one event: the event, its dated note timeline (oldest first), and the activities linked to it.",
    responses: {
      200: {
        description: "Event detail",
        content: { "application/json": { schema: resolver(EventDetailSchema) } },
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
  async (c) => {
    const { id } = c.req.valid("param");
    const detail = await eventController.getEventDetail(c.env.db, c.get("userId"), id);
    return c.json(detail);
  },
);

const createEventSchema = z.object({
  activityId: z.number().int().positive().optional(),
  eventType: z.enum(eventTypeEnum.enumValues),
  bodyLocation: z.string().min(1).nullable().optional(),
  note: z.string().min(1),
  startTime: z.string().datetime().optional(),
  status: z.enum(eventStatusEnum.enumValues).optional(),
});

eventsRouter.post(
  "/",
  describeRoute({
    description:
      "Create an event. When `activityId` is given the event is linked to that activity and `startTime` defaults to its start date. When omitted the event is standalone (`startTime` defaults to now). `note` becomes the event's anchor note (canonical summary).",
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

const updateEventSchema = z
  .object({
    eventType: z.enum(eventTypeEnum.enumValues).optional(),
    bodyLocation: z.string().min(1).nullable().optional(),
    status: z.enum(eventStatusEnum.enumValues).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

eventsRouter.patch(
  "/:id",
  describeRoute({
    description:
      "Edit an event's structural fields (body location, type, status). Toggling `status` keeps `resolvedAt` in sync. The summary text lives in the anchor note — edit it via PATCH /:id/notes/:noteId.",
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
  activityId: z.coerce.number().int().positive().optional(),
});

eventsRouter.delete(
  "/:id",
  describeRoute({
    description:
      "With `activityId`: unlink the event from that activity (and delete the event when it was its last link). Without `activityId`: delete the event outright (cascading its notes and links).",
    responses: {
      200: {
        description: "Delete result",
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
    const result =
      activityId !== undefined
        ? await eventController.unlinkEvent(c.env.db, c.get("userId"), id, activityId)
        : await eventController.deleteEvent(c.env.db, c.get("userId"), id);
    return c.json(result);
  },
);

const createNoteSchema = z.object({
  note: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
  trend: z.enum(noteTrendEnum.enumValues).optional(),
  severity: z.number().int().min(1).max(10).optional(),
});

eventsRouter.post(
  "/:id/notes",
  describeRoute({
    description:
      "Append a dated note to an event's timeline (source `user`). Does not change the event's status. `occurredAt` defaults to now; `trend` and `severity` (1–10) are optional.",
    responses: {
      201: {
        description: "Created note",
        content: { "application/json": { schema: resolver(EventNoteSchema) } },
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
  validator("json", createNoteSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const created = await eventController.addNote(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(created, 201);
  },
);

const noteIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  noteId: z.coerce.number().int().positive(),
});

const updateNoteSchema = z
  .object({
    note: z.string().min(1).optional(),
    occurredAt: z.string().datetime().optional(),
    trend: z.enum(noteTrendEnum.enumValues).nullable().optional(),
    severity: z.number().int().min(1).max(10).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

eventsRouter.patch(
  "/:id/notes/:noteId",
  describeRoute({
    description:
      "Edit a note on an event's timeline. The AI-authored anchor note is editable (Carl's ask); any note's `note`, `occurredAt`, `trend`, or `severity` may change.",
    responses: {
      200: {
        description: "Updated note",
        content: { "application/json": { schema: resolver(EventNoteSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Note not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", noteIdParamSchema),
  validator("json", updateNoteSchema),
  async (c) => {
    const { id, noteId } = c.req.valid("param");
    const updated = await eventController.updateNote(
      c.env.db,
      c.get("userId"),
      id,
      noteId,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

eventsRouter.delete(
  "/:id/notes/:noteId",
  describeRoute({
    description:
      "Delete a note from an event's timeline. The anchor note (canonical summary) cannot be deleted.",
    responses: {
      200: {
        description: "Delete result",
        content: { "application/json": { schema: resolver(DeleteEventNoteResponseSchema) } },
      },
      400: {
        description: "The anchor note cannot be deleted",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Note not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", noteIdParamSchema),
  async (c) => {
    const { id, noteId } = c.req.valid("param");
    const result = await eventController.deleteNote(c.env.db, c.get("userId"), id, noteId);
    return c.json(result);
  },
);

export default eventsRouter;
