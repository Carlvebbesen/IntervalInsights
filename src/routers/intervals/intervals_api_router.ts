import { Hono } from "hono";
import { logger } from "../../logger";
import { syncAllFromIntervals } from "../../services/intervals_link_service";
import type { TIntervalsEnv } from "../../types/IRouters";

const intervalsApiRouter = new Hono<TIntervalsEnv>();

intervalsApiRouter.post("/sync", async (c) => {
  const userId = c.get("userId");
  void syncAllFromIntervals(c.env, { id: userId }).catch((err) => {
    logger.error({ err, userId }, "intervals.icu master sync (background) failed");
  });
  return c.json({ status: "started" as const }, 202);
});

export default intervalsApiRouter;
