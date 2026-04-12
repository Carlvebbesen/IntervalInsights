import { Hono } from "hono";
import type { TIntervalsEnv } from "../../types/IRouters";
import { intervalsApiService } from "../../services.ts/intervals_api_service";

const intervalsApiRouter = new Hono<TIntervalsEnv>();

// ── Activity-level endpoints (for detail pages) ──

intervalsApiRouter.get("/activity/:id", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const activityId = c.req.param("id");
  const data = await intervalsApiService.getActivity(apiKey, activityId);
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/intervals", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const activityId = c.req.param("id");
  const data = await intervalsApiService.getActivityIntervals(apiKey, activityId);
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/streams", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const activityId = c.req.param("id");
  const data = await intervalsApiService.getActivityStreams(apiKey, activityId);
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/pace-curve", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const activityId = c.req.param("id");
  const data = await intervalsApiService.getActivityPaceCurve(apiKey, activityId);
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/hr-curve", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const activityId = c.req.param("id");
  const data = await intervalsApiService.getActivityHrCurve(apiKey, activityId);
  return c.json(data);
});

// ── Athlete-level endpoints (for dashboard enrichment) ──

intervalsApiRouter.get("/wellness", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const oldest = c.req.query("oldest");
  const newest = c.req.query("newest");
  if (!oldest || !newest) {
    return c.json({ error: "oldest and newest query params required" }, 400);
  }
  const data = await intervalsApiService.getWellness(apiKey, oldest, newest);
  return c.json(data);
});

intervalsApiRouter.get("/fitness", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const oldest = c.req.query("oldest");
  const newest = c.req.query("newest");
  if (!oldest || !newest) {
    return c.json({ error: "oldest and newest query params required" }, 400);
  }
  const data = await intervalsApiService.getFitnessModel(apiKey, oldest, newest);
  return c.json(data);
});

intervalsApiRouter.get("/pace-curves", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.query())) {
    if (value) params[key] = value;
  }
  const data = await intervalsApiService.getPaceCurves(apiKey, params);
  return c.json(data);
});

intervalsApiRouter.get("/sport-settings", async (c) => {
  const apiKey = c.get("intervalsApiKey");
  const data = await intervalsApiService.getSportSettings(apiKey);
  return c.json(data);
});

export default intervalsApiRouter;
