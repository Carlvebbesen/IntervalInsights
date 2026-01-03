import { eq } from "drizzle-orm";
import { activities, getDbInsertActivity, } from "../schema";
import { IGlobalBindings,} from "../types/IRouters";
import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { isRunningActivity } from "./utils";
import { stravaApiService } from "./strava_api_service";
import { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { triggerInitialAnalysis } from "./analysis_service";

export async function processStravaWebhook(body: IStravaWebhookEvent, context: IGlobalBindings) {
  if (body.object_type !== "activity") return;

  const stravaActivityId = body.object_id;
  
  // DELETE Case
  if (body.aspect_type === "delete") {
    await context.db.delete(activities).where(eq(activities.stravaActivityId, stravaActivityId));
    return;
  }

  // Get User
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
  });

  if (!user){
    console.log("No user found");
    return;
  } 

  // Get Token (Clerk)
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const clerkUser = await clerkClient.users.getUser(user.clerkId);
  const accessToken = (clerkUser.privateMetadata as any)?.strava?.access_token;
  if (!accessToken){
    console.log("no access token");
    return;
  } 

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
  const activity = getDbInsertActivity(data, user.id);
  if (body.aspect_type === "create") {
    await context.db.insert(activities).values(activity).onConflictDoNothing();
  } else if (body.aspect_type === "update") {
    await context.db.update(activities).set(activity).where(eq(activities.stravaActivityId, stravaActivityId));
    if ((body.updates?.title || body.updates?.description) && isRunningActivity(data.type)) {
      await triggerInitialAnalysis(context.db,accessToken, stravaActivityId,0, data);
    }
  }
}