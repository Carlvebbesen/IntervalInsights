import { Hono } from 'hono';
import stravaAuthEndpoints from './strava_auth_router';
import { stravaMiddleware } from '../../middlewares/strava_middleware';
import stravaWebhookRouter from './strava_webhook_router';
import stravaApiRouter from './strava_api_router';
import { TStravaEnv } from '../../types/IRouters';

const stravaEntryRouter = new Hono<TStravaEnv>();

stravaEntryRouter.route('/auth', stravaAuthEndpoints);
stravaEntryRouter.use('*', stravaMiddleware);
stravaEntryRouter.route("/", stravaApiRouter);
stravaEntryRouter.route("/webhook", stravaWebhookRouter);

export default stravaEntryRouter;