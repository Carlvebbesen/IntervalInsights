import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { activities, intervalStructures } from "../schema";
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
    try {
      const userId = c.get("userId");
      const result = await c.env.db
        .selectDistinct({
          id: intervalStructures.id,
          name: intervalStructures.name,
          signature: intervalStructures.signature,
        })
        .from(intervalStructures)
        .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
        .where(eq(activities.userId, userId));

      return c.json(result);
    } catch (err) {
      c.var.logger.error({ err }, "Error fetching interval structures");
      return c.json({ error: "Internal Server Error" }, 500);
    }
  },
);

export default intervalStructureRouter;
