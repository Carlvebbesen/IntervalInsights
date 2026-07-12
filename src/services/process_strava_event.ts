import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { logger } from "../logger";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import * as gearRepo from "../repositories/gear_repository";
import { findOrCreateUserSettings } from "../repositories/user_settings_repository";
import { activities, gears, type InsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { distanceBand, TIME_TOLERANCE_MS } from "./activity_match";
import { triggerAnalysisByStravaId } from "./analysis_service";
import { linkActivityGearOnIngest, relinkActivityGearFromStrava } from "./gear_strava_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { classifyUserActivity, INACTIVITY_DROP_DAYS, INACTIVITY_SKIP_DAYS } from "./ingest_gating";
import { deleteProviderToken } from "./oauth_token_store";
import { progressService } from "./progress_service";
import { stravaApiService } from "./strava_api_service";
import { getDbInsertActivity } from "./strava_mappers";
import { shouldAnalyze } from "./utils";

/**
 * Find the intervals-sourced twin (`stravaActivityId IS NULL`,
 * `intervalsIcuId NOT NULL`) for a Strava activity that isn't linked by exact
 * `intervalsStravaId`. Fuzzy fallback for the device-dual-sync case where
 * intervals.icu never learned this activity's Strava id: exactly one candidate
 * within ±5 min / ±3 % distance merges; zero or ambiguous → no merge (insert).
 */
async function findFuzzyIntervalsTwin(
  context: IGlobalBindings,
  userId: string,
  activity: InsertActivity,
): Promise<{ id: number } | null> {
  if (activity.startDateLocal == null || !activity.distance || activity.distance <= 0) return null;

  const startMs = activity.startDateLocal.getTime();
  const minTime = new Date(startMs - TIME_TOLERANCE_MS);
  const maxTime = new Date(startMs + TIME_TOLERANCE_MS);
  const { min, max } = distanceBand(activity.distance);

  const candidates = await context.db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNull(activities.stravaActivityId),
        isNotNull(activities.intervalsIcuId),
        gte(activities.startDateLocal, minTime),
        lte(activities.startDateLocal, maxTime),
        gte(activities.distance, min),
        lte(activities.distance, max),
      ),
    );

  if (candidates.length !== 1) return null;
  return candidates[0];
}

/**
 * D3: when the user opted out of waiting for the intervals.icu-side update
 * (`waitForStravaUpdate === false`), kick analysis off right away instead of
 * leaving it for the intervals `update` webhook. Null settings (users row
 * gone mid-race) fall through to the default (wait) — no start.
 */
async function maybeStartImmediateAnalysis(
  context: IGlobalBindings,
  accessToken: string,
  stravaActivityId: number,
  userId: string,
  activityId: number,
) {
  const settings = await findOrCreateUserSettings(context.db, userId);
  if (settings?.waitForStravaUpdate === false) {
    logger.info(
      { userId, activityId, stravaActivityId },
      "Immediate analysis start (waitForStravaUpdate=false)",
    );
    await triggerAnalysisByStravaId(context.db, accessToken, stravaActivityId, userId);
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

    // Keep local gears (source of truth) but zero their derived counters — the
    // activities backing them are gone; the Strava-snapshot baseline is retained.
    await context.db
      .update(gears)
      .set({ maintainedDistanceMeters: 0, activityCount: 0 })
      .where(eq(gears.userId, user.id));

    await context.db.update(users).set({ stravaId: null }).where(eq(users.id, user.id));

    await deleteProviderToken(context.db, user.id, "strava");

    logger.info({ athleteId: body.owner_id }, "Processed Strava deauthorization");
    return;
  }

  if (body.object_type !== "activity") return;

  const stravaActivityId = body.object_id;
  // Strava webhooks are unsigned and the subscription-id check is weak
  // (low-entropy int). Defense-in-depth: resolve the owner from `owner_id` and
  // scope every mutation to that user's rows, so a forged event can at worst
  // touch the forger's own data.
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
  });
  if (!user) {
    logger.info({ ownerId: body.owner_id }, "No user found for strava event");
    return;
  }

  if (body.aspect_type === "delete") {
    const [row] = await context.db
      .select({
        id: activities.id,
        userId: activities.userId,
        localGearId: activities.localGearId,
      })
      .from(activities)
      .where(
        and(eq(activities.stravaActivityId, stravaActivityId), eq(activities.userId, user.id)),
      );
    if (!row) return;
    if (row.localGearId != null) {
      // Detach (decrements the gear's counters) before the row disappears.
      await gearRepo.assignActivityToGear(context.db, row.userId, row.id, null);
    }
    return await context.db.delete(activities).where(eq(activities.id, row.id));
  }

  const accessToken = (await getStravaAccessTokens(user.id)).access_token;

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
  // Never trust the payload's owner claim: re-validate against the activity
  // Strava actually returns for the resolved user's token.
  if (data.athlete?.id !== body.owner_id) {
    logger.warn(
      { stravaActivityId, claimedOwner: body.owner_id, actualOwner: data.athlete?.id },
      "Strava event owner mismatch — ignoring",
    );
    return;
  }
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
    // instead of inserting a duplicate. Merge the Strava metadata onto it,
    // attach the Strava id, and re-arm analysis — intervals enrichment fields
    // are left untouched (not in the payload). Exact `intervalsStravaId` join
    // first (intervals.icu reported this Strava id); fall back to a fuzzy
    // time/distance match for the device-dual-sync case where intervals.icu
    // never learned the Strava id.
    const exactTwin = await context.db.query.activities.findFirst({
      where: (a, { and, eq, isNull }) =>
        and(
          eq(a.userId, user.id),
          eq(a.intervalsStravaId, stravaActivityId),
          isNull(a.stravaActivityId),
        ),
      columns: { id: true },
    });
    const twin = exactTwin ?? (await findFuzzyIntervalsTwin(context, user.id, activity));

    if (twin) {
      await context.db
        .update(activities)
        .set({ ...payload, analysisStatus: payload.analysisStatus ?? "pending" })
        .where(eq(activities.id, twin.id));
      if (data.gear_id && activity.startDateLocal) {
        await linkActivityGearOnIngest(context.db, user.id, accessToken, twin.id, {
          stravaGearId: data.gear_id,
          sportType: data.sport_type,
          indoor: data.trainer ?? false,
          startDateLocal: activity.startDateLocal,
        });
      }
      logger.info(
        {
          stravaActivityId,
          userId: user.id,
          mergedInto: twin.id,
          via: exactTwin ? "exact" : "fuzzy",
        },
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
        await maybeStartImmediateAnalysis(context, accessToken, stravaActivityId, user.id, twin.id);
      }
      return;
    }

    const [inserted] = await context.db
      .insert(activities)
      .values(payload)
      .onConflictDoNothing()
      .returning({ id: activities.id });
    if (inserted && data.gear_id && activity.startDateLocal) {
      await linkActivityGearOnIngest(context.db, user.id, accessToken, inserted.id, {
        stravaGearId: data.gear_id,
        sportType: data.sport_type,
        indoor: data.trainer ?? false,
        startDateLocal: activity.startDateLocal,
      });
    }
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
      await maybeStartImmediateAnalysis(
        context,
        accessToken,
        stravaActivityId,
        user.id,
        inserted.id,
      );
    }
    return;
  }

  if (body.aspect_type === "update") {
    const [existing] = await context.db
      .select({
        id: activities.id,
        distance: activities.distance,
        gearId: activities.gearId,
      })
      .from(activities)
      .where(
        and(eq(activities.stravaActivityId, stravaActivityId), eq(activities.userId, user.id)),
      );
    if (!existing) return;
    await context.db.update(activities).set(activity).where(eq(activities.id, existing.id));
    // Keep the assigned gear's maintained distance in sync. localGearId is
    // preserved (the mapper never sets it, so manual assignments survive).
    await gearRepo.adjustForDistanceChange(
      context.db,
      existing.id,
      existing.distance,
      activity.distance,
    );
    const newStravaGearId = data.gear_id ?? null;
    if (newStravaGearId !== (existing.gearId ?? null) && activity.startDateLocal) {
      // The user changed the gear on Strava — re-link and remember the choice.
      const relinked = await relinkActivityGearFromStrava(
        context.db,
        user.id,
        accessToken,
        existing.id,
        {
          stravaGearId: newStravaGearId,
          sportType: data.sport_type,
          indoor: data.trainer ?? false,
          startDateLocal: activity.startDateLocal,
        },
      );
      if (relinked) {
        await context.db
          .update(activities)
          .set({ gearUpdatedFromStrava: true })
          .where(eq(activities.id, existing.id));
      }
    }
    if (activityClass === "active" && (body.updates?.title || body.updates?.description)) {
      await triggerAnalysisByStravaId(context.db, accessToken, stravaActivityId, user.id);
    }
  }
}
