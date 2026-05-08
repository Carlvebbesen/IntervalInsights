import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities, getDbInsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { restartAnalysisByStravaId } from "./analysis_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { stravaApiService } from "./strava_api_service";
import { shouldAnalyze } from "./utils";

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
    return await context.db
      .delete(activities)
      .where(eq(activities.stravaActivityId, stravaActivityId));
  }
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
  });
  if (!user) {
    console.log("No user found for strava event");
    return;
  }
  const accessToken = (await getStravaAccessTokens(user.clerkId)).access_token;
  if (!accessToken) {
    console.log("no access token");
    return;
  }

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
  if (!shouldAnalyze(data.sport_type)) {
    return console.log(`Does not analyze that sportType:${data.sport_type} with id: ${data.id}`);
  }
  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);
  const activity = getDbInsertActivity(data, user.id, processHeartRate);
  if (body.aspect_type === "create") {
    await context.db.insert(activities).values(activity).onConflictDoNothing();
  } else if (body.aspect_type === "update") {
    await context.db
      .update(activities)
      .set(activity)
      .where(eq(activities.stravaActivityId, stravaActivityId));
    if (body.updates?.title || body.updates?.description) {
      await restartAnalysisByStravaId(context.db, accessToken, stravaActivityId, user.id);
    }
  }
}
