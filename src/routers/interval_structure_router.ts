import { TGlobalEnv } from "../types/IRouters";
import { activities, intervalStructures } from "../schema";
import { eq, } from "drizzle-orm";
import { Hono } from "hono";

const intervalStructureRouter = new Hono<TGlobalEnv>();

intervalStructureRouter.get("/filter", async (c) => {
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
  } catch (error) {
    console.error("Error fetching interval structures:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default intervalStructureRouter;
