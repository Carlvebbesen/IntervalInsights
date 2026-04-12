import { eq } from "drizzle-orm";
import { activities, getDbInsertActivity, users } from "../schema";
import { IGlobalBindings,} from "../types/IRouters";
import { shouldAnalyze } from "./utils";
import { stravaApiService } from "./strava_api_service";
import { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { triggerInitialAnalysis } from "./analysis_service";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { createClerkClient } from "@clerk/backend";
import { env } from "bun";

export async function processStravaWebhook(body: IStravaWebhookEvent, context: IGlobalBindings) {
  if (body.object_type === "athlete" && body.aspect_type === "update") {
    // Strava deauthorization event
    const user = await context.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
    });
    if (!user) return;

    // Delete all activities (interval_segments cascade via ON DELETE CASCADE)
    await context.db.delete(activities).where(eq(activities.userId, user.id));

    // Clear Strava connection
    await context.db.update(users).set({ stravaId: null }).where(eq(users.id, user.id));

    // Clear Clerk metadata
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    await clerkClient.users.updateUserMetadata(user.clerkId, {
      privateMetadata: { strava: null },
      publicMetadata: { strava_connected: false },
    });

    console.log(`Processed deauthorization for Strava athlete ${body.owner_id}`);
    return;
  }

  if (body.object_type !== "activity") return;

  const stravaActivityId = body.object_id;
  if (body.aspect_type === "delete") {
    return await context.db.delete(activities).where(eq(activities.stravaActivityId, stravaActivityId));
  }
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
  });
  if (!user){
    console.log("No user found for strava event");
    return;
  } 
  const accessToken = (await getStravaAccessTokens(user.clerkId)).access_token;
  if (!accessToken){
    console.log("no access token");
    return;
  } 

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
  if(!shouldAnalyze(data.sport_type)){
    return console.log(`Does not analyze that sportType:${data.sport_type} with id: ${data.id}`);
  }
  const activity = getDbInsertActivity(data, user.id);
  if (body.aspect_type === "create") {
    await context.db.insert(activities).values(activity).onConflictDoNothing();
  } else if (body.aspect_type === "update") {
    await context.db.update(activities).set(activity).where(eq(activities.stravaActivityId, stravaActivityId));
    if ((body.updates?.title || body.updates?.description)) {
      await triggerInitialAnalysis(context.db,accessToken, stravaActivityId,0, data);
    }
  }
}