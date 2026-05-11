import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { intervalsApiService } from "../../services.ts/intervals_api_service";
import type { TIntervalsEnv } from "../../types/IRouters";

const intervalsApiRouter = new Hono<TIntervalsEnv>();

const DateRangeSchema = z.object({
  oldest: z.string(),
  newest: z.string(),
});

intervalsApiRouter.get("/activity/:id", async (c) => {
  const data = await intervalsApiService.getActivity(
    c.get("intervalsAccessToken"),
    c.req.param("id"),
  );
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/intervals", async (c) => {
  const data = await intervalsApiService.getActivityIntervals(
    c.get("intervalsAccessToken"),
    c.req.param("id"),
  );
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/streams", async (c) => {
  const data = await intervalsApiService.getActivityStreams(
    c.get("intervalsAccessToken"),
    c.req.param("id"),
  );
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/pace-curve", async (c) => {
  const data = await intervalsApiService.getActivityPaceCurve(
    c.get("intervalsAccessToken"),
    c.req.param("id"),
  );
  return c.json(data);
});

intervalsApiRouter.get("/activity/:id/hr-curve", async (c) => {
  const data = await intervalsApiService.getActivityHrCurve(
    c.get("intervalsAccessToken"),
    c.req.param("id"),
  );
  return c.json(data);
});

intervalsApiRouter.get("/wellness", validator("query", DateRangeSchema), async (c) => {
  const { oldest, newest } = c.req.valid("query");
  const data = await intervalsApiService.getWellness(c.get("intervalsAccessToken"), oldest, newest);
  return c.json(data);
});

intervalsApiRouter.get("/fitness", validator("query", DateRangeSchema), async (c) => {
  const { oldest, newest } = c.req.valid("query");
  const data = await intervalsApiService.getFitnessModel(
    c.get("intervalsAccessToken"),
    oldest,
    newest,
  );
  return c.json(data);
});

intervalsApiRouter.get("/pace-curves", async (c) => {
  const data = await intervalsApiService.getPaceCurves(
    c.get("intervalsAccessToken"),
    c.req.query(),
  );
  return c.json(data);
});

intervalsApiRouter.get("/sport-settings", async (c) => {
  const data = await intervalsApiService.getSportSettings(c.get("intervalsAccessToken"));
  return c.json(data);
});

export default intervalsApiRouter;
