import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as raceEventController from "../controllers/race_event_controller";
import { raceEventStatusEnum, racePriorityEnum } from "../schema";
import {
  DeleteRaceEventResponseSchema,
  ErrorSchema,
  RaceEventListResponseSchema,
  RaceEventSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const raceEventsRouter = new Hono<TGlobalEnv>();

const listQuerySchema = z.object({
  status: z.enum(raceEventStatusEnum.enumValues).optional(),
});

raceEventsRouter.get(
  "/",
  describeRoute({
    description:
      "List every race event for the authenticated user, ordered by date ascending. Optional filter: `status`.",
    responses: {
      200: {
        description: "All race events for the user",
        content: { "application/json": { schema: resolver(RaceEventListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", listQuerySchema),
  async (c) => {
    const data = await raceEventController.listRaceEvents(
      c.env.db,
      c.get("userId"),
      c.req.valid("query"),
    );
    return c.json({ data });
  },
);

const createRaceEventSchema = z.object({
  name: z.string().min(1),
  date: z.string().date(),
  distanceMeters: z.number().int().positive(),
  targetTimeSeconds: z.number().int().positive().optional(),
  priority: z.enum(racePriorityEnum.enumValues).optional(),
  status: z.enum(raceEventStatusEnum.enumValues).optional(),
});

raceEventsRouter.post(
  "/",
  describeRoute({
    description: "Create a race event.",
    responses: {
      201: {
        description: "Created race event",
        content: { "application/json": { schema: resolver(RaceEventSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", createRaceEventSchema),
  async (c) => {
    const created = await raceEventController.createRaceEvent(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(created, 201);
  },
);

const raceEventIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateRaceEventSchema = z
  .object({
    name: z.string().min(1).optional(),
    date: z.string().date().optional(),
    distanceMeters: z.number().int().positive().optional(),
    targetTimeSeconds: z.number().int().positive().nullable().optional(),
    priority: z.enum(racePriorityEnum.enumValues).optional(),
    status: z.enum(raceEventStatusEnum.enumValues).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

raceEventsRouter.patch(
  "/:id",
  describeRoute({
    description: "Edit a race event.",
    responses: {
      200: {
        description: "Updated race event",
        content: { "application/json": { schema: resolver(RaceEventSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Race event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", raceEventIdParamSchema),
  validator("json", updateRaceEventSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const updated = await raceEventController.updateRaceEvent(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

raceEventsRouter.delete(
  "/:id",
  describeRoute({
    description: "Delete a race event.",
    responses: {
      200: {
        description: "Delete result",
        content: { "application/json": { schema: resolver(DeleteRaceEventResponseSchema) } },
      },
      404: {
        description: "Race event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", raceEventIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await raceEventController.deleteRaceEvent(c.env.db, c.get("userId"), id);
    return c.json(result);
  },
);

export default raceEventsRouter;
