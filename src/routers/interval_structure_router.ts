import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import * as intervalStructureController from "../controllers/interval_structure_controller";
import { ErrorSchema, IntervalStructureSchema } from "../schemas/api_schemas";
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

export default intervalStructureRouter;
