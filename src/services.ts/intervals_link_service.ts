import { createClerkClient } from "@clerk/backend";
import { env, sleep } from "bun";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { IntervalsError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { activities, type InsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsActivity } from "../types/intervals/IIntervalsActivity";
import { intervalsApiService } from "./intervals_api_service";

type EnrichmentFields = Partial<
  Pick<
    InsertActivity,
    | "elapsedTime"
    | "maxHeartRate"
    | "averagePower"
    | "weightedAveragePower"
    | "calories"
    | "deviceName"
    | "icuTrainingLoad"
    | "icuIntensity"
    | "decoupling"
    | "polarizationIndex"
    | "icuFtp"
    | "icuCtl"
    | "icuAtl"
  >
>;

function buildEnrichment(activity: IIntervalsActivity): EnrichmentFields {
  return {
    elapsedTime: activity.elapsed_time ?? null,
    maxHeartRate: activity.max_heartrate ?? null,
    averagePower: activity.icu_average_watts ?? null,
    weightedAveragePower: activity.icu_weighted_avg_watts ?? null,
    calories: activity.calories ?? null,
    deviceName: activity.device_name ?? null,
    icuTrainingLoad: activity.icu_training_load ?? null,
    icuIntensity: activity.icu_intensity ?? null,
    decoupling: activity.decoupling ?? null,
    polarizationIndex: activity.polarization_index ?? null,
    icuFtp: activity.icu_ftp ?? null,
    icuCtl: activity.icu_ctl ?? null,
    icuAtl: activity.icu_atl ?? null,
  };
}

const TIME_TOLERANCE_MS = 5 * 60 * 1000;
const DISTANCE_TOLERANCE_RATIO = 0.03;
const LIST_WINDOW_MS = 60 * 60 * 1000;

// intervals.icu returns start_date_local as naïve local time (no `Z`).
// We store local times as UTC instants, so parse the naïve string as UTC.
function parseIntervalsLocalStartMs(value: string | undefined | null): number {
  if (!value) return NaN;
  const normalized = value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return new Date(normalized).getTime();
}

export interface LinkResult {
  localActivityId: number;
  intervalsActivityId: string;
}

function matchesByDistanceAndTime(
  intervalsStartMs: number,
  intervalsDistance: number,
  localStartMs: number,
  localDistance: number,
): boolean {
  const timeDelta = Math.abs(intervalsStartMs - localStartMs);
  if (timeDelta > TIME_TOLERANCE_MS) return false;

  const minDistance = intervalsDistance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = intervalsDistance * (1 + DISTANCE_TOLERANCE_RATIO);
  return localDistance >= minDistance && localDistance <= maxDistance;
}

async function findLocalByFuzzyMatch(
  context: IGlobalBindings,
  userId: string,
  intervalsActivity: IIntervalsActivity,
): Promise<{ id: number } | null> {
  const startMs = parseIntervalsLocalStartMs(intervalsActivity.start_date_local);
  if (Number.isNaN(startMs)) return null;

  const minTime = new Date(startMs - TIME_TOLERANCE_MS);
  const maxTime = new Date(startMs + TIME_TOLERANCE_MS);

  const minDistance = intervalsActivity.distance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = intervalsActivity.distance * (1 + DISTANCE_TOLERANCE_RATIO);

  const candidates = await context.db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNull(activities.intervalsIcuId),
        gte(activities.startDateLocal, minTime),
        lte(activities.startDateLocal, maxTime),
        gte(activities.distance, minDistance),
        lte(activities.distance, maxDistance),
      ),
    );

  if (candidates.length !== 1) return null;
  return candidates[0];
}

async function commitLink(
  context: IGlobalBindings,
  localActivityId: number,
  intervalsActivity: IIntervalsActivity,
): Promise<void> {
  await context.db
    .update(activities)
    .set({
      intervalsIcuId: intervalsActivity.id,
      intervalsAnalyzed: true,
      intervalsIcuEnrichedAt: new Date(),
      ...buildEnrichment(intervalsActivity),
    })
    .where(and(eq(activities.id, localActivityId), isNull(activities.intervalsIcuId)));
}

export async function linkFromIntervalsActivity(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
  intervalsActivityId: string,
): Promise<LinkResult | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return null;
  }

  const intervalsActivity = await intervalsApiService.getActivity(accessToken, intervalsActivityId);

  const match = await findLocalByFuzzyMatch(context, user.id, intervalsActivity);
  if (!match) return null;

  await commitLink(context, match.id, intervalsActivity);
  return { localActivityId: match.id, intervalsActivityId };
}

export async function linkFromLocalActivity(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
  localActivityId: number,
): Promise<LinkResult | null> {
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, localActivityId), eq(a.userId, user.id)),
    columns: {
      id: true,
      startDateLocal: true,
      distance: true,
      intervalsIcuId: true,
    },
  });
  if (!activity || activity.intervalsIcuId) return null;

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return null;
  }

  const localStartMs = activity.startDateLocal.getTime();
  const oldest = new Date(localStartMs - LIST_WINDOW_MS).toISOString().slice(0, 10);
  const newest = new Date(localStartMs + LIST_WINDOW_MS).toISOString().slice(0, 10);

  let candidates: IIntervalsActivity[];
  try {
    candidates = await intervalsApiService.listActivities(accessToken, oldest, newest);
  } catch (err) {
    logger.error({ err }, "intervals.icu listActivities failed");
    return null;
  }

  const fuzzy = candidates.filter((candidate) => {
    const candidateStart = parseIntervalsLocalStartMs(candidate.start_date_local);
    if (Number.isNaN(candidateStart)) return false;
    return matchesByDistanceAndTime(
      candidateStart,
      candidate.distance,
      localStartMs,
      activity.distance,
    );
  });
  if (fuzzy.length !== 1) return null;

  // Re-fetch by id so we get the full activity payload (icu_ctl/icu_atl/icu_ftp
  // and other fitness-state fields may only be populated post-analysis and
  // missing from the list response).
  let full: IIntervalsActivity;
  try {
    full = await intervalsApiService.getActivity(accessToken, fuzzy[0].id);
  } catch (err) {
    logger.error({ err, intervalsActivityId: fuzzy[0].id }, "intervals.icu getActivity failed");
    full = fuzzy[0];
  }

  await commitLink(context, activity.id, full);
  return { localActivityId: activity.id, intervalsActivityId: full.id };
}

export async function enrichActivityFromIntervalsIcu(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
  localActivityId: number,
): Promise<"enriched" | "linked" | "skipped" | "no_match" | "no_token"> {
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, localActivityId), eq(a.userId, user.id)),
    columns: {
      id: true,
      intervalsIcuId: true,
      intervalsIcuEnrichedAt: true,
    },
  });
  if (!activity) return "no_match";

  if (activity.intervalsIcuId && activity.intervalsIcuEnrichedAt) {
    return "skipped";
  }

  if (!activity.intervalsIcuId) {
    const result = await linkFromLocalActivity(context, user, localActivityId);
    return result ? "linked" : "no_match";
  }

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return "no_token";
  }

  let full: IIntervalsActivity;
  try {
    full = await intervalsApiService.getActivity(accessToken, activity.intervalsIcuId);
  } catch (err) {
    logger.error(
      { err, intervalsActivityId: activity.intervalsIcuId },
      "intervals.icu getActivity failed during enrichment",
    );
    return "no_match";
  }

  await context.db
    .update(activities)
    .set({
      intervalsIcuEnrichedAt: new Date(),
      ...buildEnrichment(full),
    })
    .where(eq(activities.id, activity.id));

  return "enriched";
}

const SYNC_BATCH_LIMIT = 100;
const SYNC_THROTTLE_MS = 100;

export interface SyncIntervalsResult {
  candidates: number;
  linked: number;
  noMatch: number;
  failed: number;
}

export async function syncUnlinkedActivities(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
): Promise<SyncIntervalsResult> {
  const rows = await context.db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.userId, user.id), isNull(activities.intervalsIcuId)))
    .orderBy(desc(activities.startDateLocal))
    .limit(SYNC_BATCH_LIMIT);

  const result: SyncIntervalsResult = {
    candidates: rows.length,
    linked: 0,
    noMatch: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      const link = await linkFromLocalActivity(context, user, row.id);
      if (link) result.linked++;
      else result.noMatch++;
    } catch (err) {
      result.failed++;
      logger.error({ err, activityId: row.id }, "intervals.icu sync failed for activity");
    }
    await sleep(SYNC_THROTTLE_MS);
  }

  return result;
}

export async function disconnectIntervals(
  context: IGlobalBindings,
  clerkUserId: string,
): Promise<void> {
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: { intervals: null },
    publicMetadata: { intervals_connected: false },
  });
  await context.db
    .update(users)
    .set({ intervalsAthleteId: null })
    .where(eq(users.clerkId, clerkUserId));
}

export async function handleIntervalsScopeChange(
  context: IGlobalBindings,
  user: { clerkId: string },
): Promise<"disconnected" | "still_valid" | "already_disconnected"> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return "already_disconnected";
  }

  try {
    await intervalsApiService.getAthlete(accessToken);
    return "still_valid";
  } catch (err) {
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      await disconnectIntervals(context, user.clerkId);
      return "disconnected";
    }
    throw err;
  }
}
