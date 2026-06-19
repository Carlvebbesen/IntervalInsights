import { Hono } from "hono";
import { syncAllFromIntervals } from "../../services/intervals_link_service";
import type { TIntervalsEnv } from "../../types/IRouters";

const intervalsApiRouter = new Hono<TIntervalsEnv>();

intervalsApiRouter.post("/sync", async (c) => {
  const result = await syncAllFromIntervals(c.env, {
    id: c.get("userId"),
    clerkId: c.get("clerkUserId"),
  });
  c.var.logger.info(result, "intervals.icu master sync completed");
  return c.json(result);
});

export default intervalsApiRouter;
