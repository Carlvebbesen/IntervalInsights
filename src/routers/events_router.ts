import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { eventStatusEnum, events, eventTypeEnum } from "../schema";
import { ErrorSchema, EventListResponseSchema } from "../schemas/api_schemas";
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
    try {
      const userId = c.get("userId");
      const { status, eventType } = c.req.valid("query");

      const filters = [eq(events.userId, userId)];
      if (status) filters.push(eq(events.status, status));
      if (eventType) filters.push(eq(events.eventType, eventType));

      const rows = await c.env.db
        .select({
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
        })
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

export default eventsRouter;
