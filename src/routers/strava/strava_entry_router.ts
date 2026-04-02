import { Hono } from "hono";
import { stravaMiddleware } from "../../middlewares/strava_middleware";
import type { TStravaEnv } from "../../types/IRouters";
import stravaApiRouter from "./strava_api_router";
import stravaAuthEndpoints from "./strava_auth_router";
import stravaWebhookRouter from "./strava_webhook_router";

const stravaEntryRouter = new Hono<TStravaEnv>();

stravaEntryRouter.route("/auth", stravaAuthEndpoints);
stravaEntryRouter.use("*", stravaMiddleware);
stravaEntryRouter.route("/", stravaApiRouter);
stravaEntryRouter.route("/webhook", stravaWebhookRouter);

export default stravaEntryRouter;
