import { Hono } from "hono";
import { logger } from "../../logger";
import { syncAllFromIntervals } from "../../services/intervals_link_service";
import type { TIntervalsEnv } from "../../types/IRouters";

const intervalsApiRouter = new Hono<TIntervalsEnv>();

intervalsApiRouter.post("/sync", async (c) => {
  const userId = c.get("userId");
  const clerkId = c.get("clerkUserId");
  // Fire-and-forget: the backfill walks years of history and can run long, so
  // don't hold the HTTP connection open. The service never throws and pushes
  // its own started/completed events over the SSE progress channel.
  void syncAllFromIntervals(c.env, { id: userId, clerkId }).catch((err) => {
    logger.error({ err, userId }, "intervals.icu master sync (background) failed");
  });
  return c.json({ status: "started" as const }, 202);
});

export default intervalsApiRouter;
