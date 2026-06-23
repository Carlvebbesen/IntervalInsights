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
import { progressService } from "./progress_service";
import { stravaApiService } from "./strava_api_service";
import { getDbInsertActivity } from "./strava_mappers";
import { shouldAnalyze } from "./utils";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const INACTIVITY_SKIP_DAYS = 60;
const INACTIVITY_DROP_DAYS = 90;

function classifyUserActivity(lastSeenAt: Date | null): "active" | "skip" | "drop" {
  if (lastSeenAt == null) {
    return "active";
  }
  const daysSince = (Date.now() - lastSeenAt.getTime()) / MS_PER_DAY;
  if (daysSince > INACTIVITY_DROP_DAYS) return "drop";
  if (daysSince > INACTIVITY_SKIP_DAYS) return "skip";
  return "active";
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

    await context.db.update(users).set({ stravaId: null }).where(eq(users.id, user.id));

    const clerkClient = createClerkClient({ secretKey: config.CLERK_SECRET_KEY });
    await clerkClient.users.updateUserMetadata(user.clerkId, {
      privateMetadata: { strava: null },
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

  const activityClass = classifyUserActivity(user.lastSeenAt);

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

    // Converge with an existing intervals.icu-sourced row for the same workout
    // (intervals.icu reported this Strava id, but the row isn't Strava-linked
    // yet) instead of inserting a duplicate. Merge the Strava metadata onto it,
    // attach the Strava id, and re-arm analysis — intervals enrichment fields
    // are left untouched (not in the payload).
    const twin = await context.db.query.activities.findFirst({
      where: (a, { and, eq, isNull }) =>
        and(
          eq(a.userId, user.id),
          eq(a.intervalsStravaId, stravaActivityId),
          isNull(a.stravaActivityId),
        ),
      columns: { id: true },
    });

    if (twin) {
      await context.db
        .update(activities)
        .set({ ...payload, analysisStatus: payload.analysisStatus ?? "pending" })
        .where(eq(activities.id, twin.id));
      logger.info(
        { stravaActivityId, userId: user.id, mergedInto: twin.id },
        "Strava create merged into existing intervals.icu row (dedup)",
      );
      if (activityClass === "active") {
        await progressService.publish(user.id, {
          type: "progress",
          data: {
            id: twin.id,
            kind: "strava_ingest",
            phase: "received",
            analysisStatus: "pending",
            title: activity.title ?? undefined,
            startDateLocal: activity.startDateLocal?.toISOString(),
          },
        });
      }
      return;
    }

    const [inserted] = await context.db
      .insert(activities)
      .values(payload)
      .onConflictDoNothing()
      .returning({ id: activities.id });
    if (activityClass === "active" && inserted) {
      await progressService.publish(user.id, {
        type: "progress",
        data: {
          id: inserted.id,
          kind: "strava_ingest",
          phase: "received",
          analysisStatus: "pending",
          title: activity.title ?? undefined,
          startDateLocal: activity.startDateLocal?.toISOString(),
        },
      });
    }
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
