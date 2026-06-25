import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as intervalStructureController from "../controllers/interval_structure_controller";
import {
  ErrorSchema,
  IntervalStructureHistoryResponseSchema,
  IntervalStructureListResponseSchema,
  IntervalStructureSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const intervalStructureRouter = new Hono<TGlobalEnv>();

intervalStructureRouter.get(
  "/filter",
  describeRoute({
    description: "Get distinct interval structures for the authenticated user",
    responses: {
      200: {
        description: "List of interval structures",
        content: { "application/json": { schema: resolver(z.array(IntervalStructureSchema)) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const result = await intervalStructureController.listUsedStructures(c.env.db, c.get("userId"));
    return c.json(result);
  },
);

intervalStructureRouter.get(
  "/",
  describeRoute({
    description:
      "Rich list of the distinct interval structures the user has done, with how many times each was performed (activityCount) and when last done (lastDoneAt). Ordered most-recently-performed first.",
    responses: {
      200: {
        description: "Interval structures with usage counts",
        content: {
          "application/json": { schema: resolver(IntervalStructureListResponseSchema) },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const result = await intervalStructureController.listStructures(c.env.db, c.get("userId"));
    return c.json(result);
  },
);

intervalStructureRouter.get(
  "/:id/history",
  describeRoute({
    description:
      "Per-session progression for one repeated interval structure (oldest → newest): date, distance, load, avg HR and a work-rep summary (count, average work pace in sec/km, average work HR).",
    responses: {
      200: {
        description: "Structure history entries",
        content: {
          "application/json": { schema: resolver(IntervalStructureHistoryResponseSchema) },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", z.object({ id: z.coerce.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await intervalStructureController.getStructureHistory(
      c.env.db,
      c.get("userId"),
      id,
    );
    return c.json(result);
  },
);

export default intervalStructureRouter;
