import { createClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { logger } from "../logger";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { triggerAnalysisByStravaId } from "./analysis_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { stravaApiService } from "./strava_api_service";
import { getDbInsertActivity } from "./strava_mappers";
import { shouldAnalyze } from "./utils";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const INACTIVITY_SKIP_DAYS = 14;
const INACTIVITY_DROP_DAYS = 90;

async function classifyUserActivity(clerkId: string): Promise<"active" | "skip" | "drop"> {
  try {
    const clerkClient = createClerkClient({ secretKey: config.CLERK_SECRET_KEY });
    const clerkUser = await clerkClient.users.getUser(clerkId);
    const lastSignInMs = clerkUser.lastSignInAt;
    if (lastSignInMs == null) {
      return "active";
    }
    const daysSince = (Date.now() - lastSignInMs) / MS_PER_DAY;
    if (daysSince > INACTIVITY_DROP_DAYS) return "drop";
    if (daysSince > INACTIVITY_SKIP_DAYS) return "skip";
    return "active";
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Clerk user for inactivity check — defaulting to active");
    return "active";
  }
}

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
    const clerkClient = createClerkClient({ secretKey: config.CLERK_SECRET_KEY });
    await clerkClient.users.updateUserMetadata(user.clerkId, {
      privateMetadata: { strava: null },
      publicMetadata: { strava_connected: false },
    });

    logger.info({ athleteId: body.owner_id }, "Processed Strava deauthorization");
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
    logger.info({ ownerId: body.owner_id }, "No user found for strava event");
    return;
  }
  const accessToken = (await getStravaAccessTokens(user.clerkId)).access_token;
  if (!accessToken) {
    logger.info({ clerkUserId: user.clerkId }, "no access token");
    return;
  }

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
  if (!shouldAnalyze(data.sport_type)) {
    logger.info(
      { sportType: data.sport_type, stravaActivityId: data.id },
      "Does not analyze that sportType",
    );
    return;
  }
  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);
  const activity = getDbInsertActivity(data, user.id, processHeartRate);

  const activityClass = await classifyUserActivity(user.clerkId);

  if (activityClass === "drop") {
    logger.info(
      { stravaActivityId, userId: user.id, inactiveDays: INACTIVITY_DROP_DAYS },
      "Dropping Strava activity — user inactive",
    );
    return;
  }

  if (body.aspect_type === "create") {
    const payload =
      activityClass === "skip"
        ? { ...activity, analysisStatus: "skipped_inactive" as const }
        : activity;
    if (activityClass === "skip") {
      logger.info(
        { stravaActivityId, userId: user.id, inactiveDays: INACTIVITY_SKIP_DAYS },
        "Storing as skipped_inactive — user inactive",
      );
    }
    await context.db.insert(activities).values(payload).onConflictDoNothing();
    return;
  }

  if (body.aspect_type === "update") {
    await context.db
      .update(activities)
      .set(activity)
      .where(eq(activities.stravaActivityId, stravaActivityId));
    if (activityClass === "active" && (body.updates?.title || body.updates?.description)) {
      await triggerAnalysisByStravaId(context.db, accessToken, stravaActivityId, user.id);
    }
  }
}
