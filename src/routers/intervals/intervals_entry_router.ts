import { Hono } from "hono";
import { intervalsMiddleware } from "../../middlewares/intervals_middleware";
import type { TIntervalsEnv } from "../../types/IRouters";
import intervalsAuthRouter from "./intervals_auth_router";
import intervalsApiRouter from "./intervals_api_router";

const intervalsEntryRouter = new Hono<TIntervalsEnv>();

intervalsEntryRouter.route("/auth", intervalsAuthRouter);
intervalsEntryRouter.use("*", intervalsMiddleware);
intervalsEntryRouter.route("/", intervalsApiRouter);

export default intervalsEntryRouter;
