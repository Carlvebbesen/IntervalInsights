import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { logger } from "../logger";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import * as gearRepo from "../repositories/gear_repository";
import { findOrCreateUserSettings } from "../repositories/user_settings_repository";
import { activities, gears, type InsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";
import { computeAndStoreActivityLoad } from "./activity_load_service";
import { TIME_TOLERANCE_MS, withinMatchTolerance } from "./activity_match";
import { triggerAnalysisByStravaId } from "./analysis_service";
import { linkActivityGearOnIngest, relinkActivityGearFromStrava } from "./gear_strava_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { classifyUserActivity, INACTIVITY_DROP_DAYS, INACTIVITY_SKIP_DAYS } from "./ingest_gating";
import { deleteProviderToken } from "./oauth_token_store";
import { progressService } from "./progress_service";
import { stravaApiService } from "./strava_api_service";
import { getDbInsertActivity } from "./strava_mappers";
import { shouldAnalyze } from "./utils";

type Db = IGlobalBindings["db"];
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

async function findFuzzyIntervalsTwin(
  db: Executor,
  userId: string,
  activity: InsertActivity,
): Promise<{ id: number } | null> {
  if (activity.startDateLocal == null) return null;

  const startMs = activity.startDateLocal.getTime();
  const minTime = new Date(startMs - TIME_TOLERANCE_MS);
  const maxTime = new Date(startMs + TIME_TOLERANCE_MS);

  const candidates = await db
    .select({
      id: activities.id,
      startDateLocal: activities.startDateLocal,
      distance: activities.distance,
      movingTime: activities.movingTime,
      sportType: activities.sportType,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNull(activities.stravaActivityId),
        isNotNull(activities.intervalsIcuId),
        gte(activities.startDateLocal, minTime),
        lte(activities.startDateLocal, maxTime),
      ),
    );

  const matches = candidates.filter((c) =>
    withinMatchTolerance(
      {
        startMs,
        distance: activity.distance,
        movingTime: activity.movingTime,
        sportType: activity.sportType,
      },
      {
        startMs: c.startDateLocal.getTime(),
        distance: c.distance,
        movingTime: c.movingTime,
        sportType: c.sportType,
      },
    ),
  );

  if (matches.length !== 1) return null;
  return { id: matches[0].id };
}

type ExistingRow = {
  id: number;
  distance: number;
  gearId: string | null;
  analysisStatus: (typeof activities.$inferSelect)["analysisStatus"];
};

function selectByStravaId(
  db: Executor,
  userId: string,
  stravaActivityId: number,
): Promise<ExistingRow[]> {
  return db
    .select({
      id: activities.id,
      distance: activities.distance,
      gearId: activities.gearId,
      analysisStatus: activities.analysisStatus,
    })
    .from(activities)
    .where(and(eq(activities.stravaActivityId, stravaActivityId), eq(activities.userId, userId)));
}

type Resolution =
  | { kind: "duplicate"; id: number }
  | { kind: "updated"; id: number; previous: ExistingRow }
  | { kind: "merged"; id: number; via: "exact" | "fuzzy" }
  | { kind: "created"; id: number }
  | { kind: "dropped" };

/**
 * One dedup implementation for both `create` and `update`. Serialized per user
 * with an advisory lock because Strava dispatches the two events for the same
 * activity seconds apart and both handlers run fire-and-forget — without it
 * they race into two inserts.
 */
async function resolveActivityRow(
  db: Db,
  userId: string,
  stravaActivityId: number,
  aspect: "create" | "update",
  activity: InsertActivity,
  payload: InsertActivity,
): Promise<Resolution> {
  return db.transaction(async (tx): Promise<Resolution> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    const applyUpdate = async (row: ExistingRow): Promise<Resolution> => {
      if (aspect === "create") return { kind: "duplicate", id: row.id };
      await tx.update(activities).set(activity).where(eq(activities.id, row.id));
      return { kind: "updated", id: row.id, previous: row };
    };

    const [existing] = await selectByStravaId(tx, userId, stravaActivityId);
    if (existing) return applyUpdate(existing);

    const exactTwin = await tx.query.activities.findFirst({
      where: (a, { and, eq, isNull }) =>
        and(
          eq(a.userId, userId),
          eq(a.intervalsStravaId, stravaActivityId),
          isNull(a.stravaActivityId),
        ),
      columns: { id: true },
    });
    const twin = exactTwin ?? (await findFuzzyIntervalsTwin(tx, userId, activity));
    if (twin) {
      await tx
        .update(activities)
        .set({ ...payload, analysisStatus: payload.analysisStatus ?? "pending" })
        .where(eq(activities.id, twin.id));
      return { kind: "merged", id: twin.id, via: exactTwin ? "exact" : "fuzzy" };
    }

    const [inserted] = await tx
      .insert(activities)
      .values(payload)
      .onConflictDoNothing()
      .returning({ id: activities.id });
    if (inserted) return { kind: "created", id: inserted.id };

    const [raced] = await selectByStravaId(tx, userId, stravaActivityId);
    if (!raced) return { kind: "dropped" };
    return applyUpdate(raced);
  });
}

/**
 * D3: when the user opted out of waiting for the Strava-side title/description
 * edit (`waitForStravaUpdate === false`), kick analysis off right away instead
 * of leaving it for the Strava `update` webhook. Null settings (users row
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
    // Strava documents athlete-updates only for deauthorization, but the branch
    // below wipes the account — never take it on an unrecognised payload.
    if (body.updates?.authorized !== "false") {
      logger.warn(
        { athleteId: body.owner_id, updates: body.updates },
        "Ignoring Strava athlete update — not a deauthorization",
      );
      return;
    }

    const user = await context.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.stravaId, body.owner_id.toString()),
    });
    if (!user) return;

    await context.db.delete(activities).where(eq(activities.userId, user.id));

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
      await gearRepo.assignActivityToGear(context.db, row.userId, row.id, null);
    }
    return await context.db.delete(activities).where(eq(activities.id, row.id));
  }

  const accessToken = (await getStravaAccessTokens(user.id)).access_token;

  const data = await stravaApiService.getActivity(accessToken, stravaActivityId);
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
  if (activityClass === "skip") {
    logger.info(
      { stravaActivityId, userId: user.id, inactiveDays: INACTIVITY_SKIP_DAYS },
      "Storing as skipped_inactive — user inactive",
    );
  }

  const payload: InsertActivity =
    activityClass === "skip"
      ? { ...activity, analysisStatus: "skipped_inactive" as const }
      : activity;

  const resolved = await resolveActivityRow(
    context.db,
    user.id,
    stravaActivityId,
    body.aspect_type,
    activity,
    payload,
  );

  if (resolved.kind === "dropped" || resolved.kind === "duplicate") return;

  if (resolved.kind === "merged") {
    logger.info(
      { stravaActivityId, userId: user.id, mergedInto: resolved.id, via: resolved.via },
      "Strava event merged into existing intervals.icu row (dedup)",
    );
  }

  const activityId = resolved.id;

  if (resolved.kind === "created" || resolved.kind === "merged") {
    if (data.gear_id && activity.startDateLocal) {
      await linkActivityGearOnIngest(context.db, user.id, accessToken, activityId, {
        stravaGearId: data.gear_id,
        sportType: data.sport_type,
        indoor: data.trainer ?? false,
        startDateLocal: activity.startDateLocal,
      });
    }
    if (activityClass === "active") {
      await progressService.publish(user.id, {
        type: "progress",
        data: {
          id: activityId,
          kind: "strava_ingest",
          phase: "received",
          analysisStatus: payload.analysisStatus ?? "pending",
          title: activity.title ?? undefined,
          startDateLocal: activity.startDateLocal?.toISOString(),
        },
      });
      await maybeStartImmediateAnalysis(
        context,
        accessToken,
        stravaActivityId,
        user.id,
        activityId,
      );
      // An `update` that had to create the row still carries the user's edit.
      if (body.aspect_type === "update" && (body.updates?.title || body.updates?.description)) {
        await triggerAnalysisByStravaId(context.db, accessToken, stravaActivityId, user.id);
      }
    }
    await computeAndStoreActivityLoad(context.db, user.id, activityId);
    return;
  }

  const previous = resolved.previous;
  await gearRepo.adjustForDistanceChange(
    context.db,
    activityId,
    previous.distance,
    activity.distance,
  );
  const newStravaGearId = data.gear_id ?? null;
  if (newStravaGearId !== (previous.gearId ?? null) && activity.startDateLocal) {
    const relinked = await relinkActivityGearFromStrava(
      context.db,
      user.id,
      accessToken,
      activityId,
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
        .where(eq(activities.id, activityId));
    }
  }
  // Surface the edit to the app whenever a user-visible field actually changed
  // (gate on the webhook's `updates` keys, not every update event). Fires even
  // when the analysis restart is skipped by SKIP_RESTART_STATUSES — otherwise a
  // completed activity keeps a stale title in the app (the stale-title fix).
  const relevantUpdate =
    body.updates?.title != null ||
    body.updates?.description != null ||
    body.updates?.gear_id != null;
  if (activityClass === "active" && relevantUpdate) {
    await progressService.publish(user.id, {
      type: "progress",
      data: {
        id: activityId,
        kind: "strava_ingest",
        phase: "updated",
        analysisStatus: previous.analysisStatus ?? undefined,
        title: activity.title ?? undefined,
        startDateLocal: activity.startDateLocal?.toISOString(),
      },
    });
    if (body.updates?.title || body.updates?.description) {
      await triggerAnalysisByStravaId(context.db, accessToken, stravaActivityId, user.id);
    }
  }
  await computeAndStoreActivityLoad(context.db, user.id, activityId);
}
