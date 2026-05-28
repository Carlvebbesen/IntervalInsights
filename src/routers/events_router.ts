import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  activities,
  activityEvents,
  eventStatusEnum,
  events,
  eventTypeEnum,
  type InsertEvent,
} from "../schema";
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

const eventColumns = {
  id: events.id,
  eventType: events.eventType,
  bodyLocation: events.bodyLocation,
  description: events.description,
  startTime: events.startTime,
  lastOccurrence: events.lastOccurrence,
  status: events.status,
  resolvedAt: events.resolvedAt,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
} as const;

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
    try {
      const userId = c.get("userId");
      const { status, eventType } = c.req.valid("query");

      const filters = [eq(events.userId, userId)];
      if (status) filters.push(eq(events.status, status));
      if (eventType) filters.push(eq(events.eventType, eventType));

      const rows = await c.env.db
        .select(eventColumns)
        .from(events)
        .where(and(...filters))
        .orderBy(desc(events.lastOccurrence));

      return c.json({ events: rows });
    } catch (err) {
      c.var.logger.error({ err }, "Error fetching events");
      return c.json({ error: "Internal Server Error" }, 500);
    }
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
    try {
      const userId = c.get("userId");
      const { activityId, eventType, bodyLocation, description, startTime, status } =
        c.req.valid("json");

      const [activity] = await c.env.db
        .select({ startDateLocal: activities.startDateLocal })
        .from(activities)
        .where(and(eq(activities.id, activityId), eq(activities.userId, userId)));

      if (!activity) {
        return c.json({ error: "Activity not found or unauthorized" }, 404);
      }

      const occurredAt = startTime ? new Date(startTime) : activity.startDateLocal;
      const resolved = status === "resolved";

      const created = await c.env.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(events)
          .values({
            userId,
            eventType,
            bodyLocation: bodyLocation ?? null,
            description,
            startTime: occurredAt,
            lastOccurrence: occurredAt,
            status: status ?? "active",
            resolvedAt: resolved ? occurredAt : null,
          })
          .returning(eventColumns);

        await tx
          .insert(activityEvents)
          .values({ activityId, eventId: row.id })
          .onConflictDoNothing();

        return row;
      });

      return c.json(created, 201);
    } catch (err) {
      c.var.logger.error({ err }, "Error creating event");
      return c.json({ error: "Internal Server Error" }, 500);
    }
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
    try {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { eventType, bodyLocation, description, status } = c.req.valid("json");

      const updates: Partial<InsertEvent> = { updatedAt: new Date() };
      if (eventType !== undefined) updates.eventType = eventType;
      if (bodyLocation !== undefined) updates.bodyLocation = bodyLocation;
      if (description !== undefined) updates.description = description;
      if (status !== undefined) {
        updates.status = status;
        updates.resolvedAt = status === "resolved" ? new Date() : null;
      }

      const [updated] = await c.env.db
        .update(events)
        .set(updates)
        .where(and(eq(events.id, id), eq(events.userId, userId)))
        .returning(eventColumns);

      if (!updated) {
        return c.json({ error: "Event not found or unauthorized" }, 404);
      }

      return c.json(updated);
    } catch (err) {
      c.var.logger.error({ err }, "Error updating event");
      return c.json({ error: "Internal Server Error" }, 500);
    }
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
    try {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { activityId } = c.req.valid("query");

      const result = await c.env.db.transaction(async (tx) => {
        const [event] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, id), eq(events.userId, userId)));

        if (!event) return null;

        const unlinked = await tx
          .delete(activityEvents)
          .where(and(eq(activityEvents.eventId, id), eq(activityEvents.activityId, activityId)))
          .returning({ eventId: activityEvents.eventId });

        const [{ remaining }] = await tx
          .select({ remaining: count() })
          .from(activityEvents)
          .where(eq(activityEvents.eventId, id));

        let deleted = false;
        if (remaining === 0) {
          await tx.delete(events).where(eq(events.id, id));
          deleted = true;
        }

        return { unlinked: unlinked.length > 0, deleted };
      });

      if (result === null) {
        return c.json({ error: "Event not found or unauthorized" }, 404);
      }

      return c.json(result);
    } catch (err) {
      c.var.logger.error({ err }, "Error deleting event");
      return c.json({ error: "Internal Server Error" }, 500);
    }
  },
);

export default eventsRouter;
