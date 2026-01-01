import { Hono } from "hono";
import { TStravaEnv } from "../../types/IRouters";
import { stravaApiService } from "../../services.ts/strava_api_service";
import { activities } from "../../schema";
import { eq, gte, inArray, and } from "drizzle-orm";

const stravaApiRouter = new Hono<TStravaEnv>();

stravaApiRouter.get("/sync/activities", async (c) => {
  const accessToken = c.get("stravaAccessToken");
  if (!accessToken) return c.json({ error: "Unauthorized" }, 401);
  const stravaActivities = await stravaApiService.listAthleteActivities(
    accessToken, 
    c.req.query()
  );

  if (stravaActivities.length === 0) return c.json([]);
  const oldestDate = new Date(
    Math.min(...stravaActivities.map(a => new Date(a.start_date).getTime()))
  ); 

  const userId = c.get("userId");
  if(!userId){
    console.log("no user found")
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const existingInDb = await c.env.db
    .select({ stravaActivityId: activities.stravaActivityId })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId ),
        gte(activities.startDateLocal, oldestDate), 
        inArray(activities.stravaActivityId, stravaActivities.map(a => a.id))
      )
    );

  const syncedIds = new Set(existingInDb.map((a) => a.stravaActivityId));
  const filtered = stravaActivities.filter(a => !syncedIds.has(a.id));

  return c.json(filtered);
});

stravaApiRouter.post("sync/activities", async (c) => {
  const accessToken = c.get("stravaAccessToken");
  const userId = c.get("userId");
  if (!accessToken || !userId) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json()) as {ids: number[]};
  return c.json(await stravaApiService.syncStravaActivities(accessToken,userId, body.ids, c.env.db ));
} )


export default stravaApiRouter;
