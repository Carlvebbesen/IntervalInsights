import { sleep } from "bun";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { IntervalsError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { activities, type InsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsActivity } from "../types/intervals/IIntervalsActivity";
import { distanceBand, TIME_TOLERANCE_MS, withinMatchTolerance } from "./activity_match";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { classifyUserActivity } from "./ingest_gating";
import { intervalsApiService } from "./intervals_api_service";
import { mapIntervalsActivityToInsert } from "./intervals_mappers";
import { deleteProviderToken } from "./oauth_token_store";
import { publishSync } from "./progress_service";
import { shouldAnalyze } from "./utils";

type Db = IGlobalBindings["db"];
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type EnrichmentFields = Partial<
  Pick<
    InsertActivity,
    | "elapsedTime"
    | "maxHeartRate"
    | "hasHeartrate"
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

function buildEnrichment(
  activity: IIntervalsActivity,
  processHeartRate: boolean,
): EnrichmentFields {
  const base: EnrichmentFields = {
    elapsedTime: activity.elapsed_time ?? null,
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
  if (!processHeartRate) return base;
  return {
    ...base,
    maxHeartRate: activity.max_heartrate ?? null,
    ...(activity.average_heartrate != null || activity.max_heartrate != null
      ? { hasHeartrate: true }
      : {}),
  };
}

const LIST_WINDOW_MS = 60 * 60 * 1000;

function parseIntervalsLocalStartMs(value: string | undefined | null): number {
  if (!value) return NaN;
  const normalized = value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return new Date(normalized).getTime();
}

export interface LinkResult {
  localActivityId: number;
  intervalsActivityId: string;
}

async function findLocalByFuzzyMatch(
  db: Executor,
  userId: string,
  intervalsActivity: IIntervalsActivity,
): Promise<{ id: number } | null> {
  const startMs = parseIntervalsLocalStartMs(intervalsActivity.start_date_local);
  if (Number.isNaN(startMs)) return null;
  if (intervalsActivity.distance == null) return null;

  const minTime = new Date(startMs - TIME_TOLERANCE_MS);
  const maxTime = new Date(startMs + TIME_TOLERANCE_MS);
  const { min: minDistance, max: maxDistance } = distanceBand(intervalsActivity.distance);

  const candidates = await db
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
  db: Executor,
  localActivityId: number,
  intervalsActivity: IIntervalsActivity,
  processHeartRate: boolean,
): Promise<void> {
  await db
    .update(activities)
    .set({
      intervalsIcuId: intervalsActivity.id,
      intervalsAnalyzed: true,
      intervalsIcuEnrichedAt: new Date(),
      ...buildEnrichment(intervalsActivity, processHeartRate),
    })
    .where(and(eq(activities.id, localActivityId), isNull(activities.intervalsIcuId)));
}

export async function linkFromIntervalsActivity(
  context: IGlobalBindings,
  user: { id: string },
  intervalsActivityId: string,
): Promise<LinkResult | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch {
    return null;
  }

  const intervalsActivity = await intervalsApiService.getActivity(accessToken, intervalsActivityId);

  const match = await findLocalByFuzzyMatch(context.db, user.id, intervalsActivity);
  if (!match) return null;

  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);
  await commitLink(context.db, match.id, intervalsActivity, processHeartRate);
  return { localActivityId: match.id, intervalsActivityId };
}

export type IntervalsIngestOutcome =
  | "already_linked"
  | "linked_exact"
  | "linked_fuzzy"
  | "created"
  | "skipped_sport"
  | "skipped_inactive"
  | "dropped"
  | "no_token"
  | "no_activity";

export interface IntervalsIngestResult {
  outcome: IntervalsIngestOutcome;
  localActivityId?: number;
  intervalsActivityId: string;
}

export async function linkOrCreateFromIntervalsActivity(
  context: IGlobalBindings,
  user: { id: string; lastSeenAt: Date | null },
  intervalsActivityId: string,
): Promise<IntervalsIngestResult> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch {
    return { outcome: "no_token", intervalsActivityId };
  }

  const activity = await intervalsApiService.getActivity(accessToken, intervalsActivityId);
  if (!activity) return { outcome: "no_activity", intervalsActivityId };

  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);

  return context.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`);

    const existing = await tx.query.activities.findFirst({
      where: (a, { and, eq }) => and(eq(a.userId, user.id), eq(a.intervalsIcuId, activity.id)),
      columns: { id: true },
    });
    if (existing) {
      return { outcome: "already_linked", localActivityId: existing.id, intervalsActivityId };
    }

    if (activity.strava_id != null) {
      const exact = await tx.query.activities.findFirst({
        where: (a, { and, eq, isNull }) =>
          and(
            eq(a.userId, user.id),
            eq(a.stravaActivityId, activity.strava_id as number),
            isNull(a.intervalsIcuId),
          ),
        columns: { id: true },
      });
      if (exact) {
        await commitLink(tx, exact.id, activity, processHeartRate);
        return { outcome: "linked_exact", localActivityId: exact.id, intervalsActivityId };
      }
    }

    const fuzzy = await findLocalByFuzzyMatch(tx, user.id, activity);
    if (fuzzy) {
      await commitLink(tx, fuzzy.id, activity, processHeartRate);
      return { outcome: "linked_fuzzy", localActivityId: fuzzy.id, intervalsActivityId };
    }

    if (!shouldAnalyze(activity.type)) {
      return { outcome: "skipped_sport", intervalsActivityId };
    }
    const activityClass = classifyUserActivity(user.lastSeenAt);
    if (activityClass === "drop") {
      return { outcome: "dropped", intervalsActivityId };
    }

    const payload: InsertActivity = {
      ...mapIntervalsActivityToInsert(activity, user.id, processHeartRate),
      intervalsAnalyzed: true,
      intervalsIcuEnrichedAt: new Date(),
      analysisStatus: activityClass === "skip" ? "skipped_inactive" : "pending",
      ...buildEnrichment(activity, processHeartRate),
    };
    const [inserted] = await tx
      .insert(activities)
      .values(payload)
      .onConflictDoNothing()
      .returning({ id: activities.id });
    if (!inserted) {
      const raced = await tx.query.activities.findFirst({
        where: (a, { and, eq }) => and(eq(a.userId, user.id), eq(a.intervalsIcuId, activity.id)),
        columns: { id: true },
      });
      return { outcome: "already_linked", localActivityId: raced?.id, intervalsActivityId };
    }
    return {
      outcome: activityClass === "skip" ? "skipped_inactive" : "created",
      localActivityId: inserted.id,
      intervalsActivityId,
    };
  });
}

export async function refreshLinkedIntervalsActivity(
  context: IGlobalBindings,
  user: { id: string },
  localActivityId: number,
): Promise<"refreshed" | "no_token" | "no_source" | "no_match"> {
  const row = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, localActivityId), eq(a.userId, user.id)),
    columns: { id: true, intervalsIcuId: true },
  });
  if (!row) return "no_match";
  if (!row.intervalsIcuId) return "no_source";

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch {
    return "no_token";
  }

  let full: IIntervalsActivity;
  try {
    full = await intervalsApiService.getActivity(accessToken, row.intervalsIcuId);
  } catch (err) {
    logger.error(
      { err, intervalsActivityId: row.intervalsIcuId },
      "intervals.icu getActivity failed during refresh",
    );
    return "no_match";
  }
  if (!full) return "no_match";

  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);
  const hrFields = processHeartRate ? { averageHeartRate: full.average_heartrate ?? null } : {};

  await context.db
    .update(activities)
    .set({
      intervalsAnalyzed: true,
      intervalsIcuEnrichedAt: new Date(),
      distance: full.distance ?? 0,
      movingTime: full.moving_time ?? 0,
      totalElevationGain: full.total_elevation_gain ?? null,
      sportType: full.type || "Workout",
      indoor: full.trainer ?? false,
      ...hrFields,
      ...buildEnrichment(full, processHeartRate),
    })
    .where(eq(activities.id, row.id));

  return "refreshed";
}

export async function linkFromLocalActivity(
  context: IGlobalBindings,
  user: { id: string },
  localActivityId: number,
): Promise<LinkResult | null> {
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, localActivityId), eq(a.userId, user.id)),
    columns: {
      id: true,
      startDateLocal: true,
      distance: true,
      intervalsIcuId: true,
      stravaActivityId: true,
    },
  });
  if (!activity || activity.intervalsIcuId) return null;

  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch (err) {
    logger.warn({ err, localActivityId }, "intervals.icu link skipped — no usable access token");
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

  if (activity.stravaActivityId != null) {
    const exact = candidates.filter((c) => c.strava_id === activity.stravaActivityId);
    if (exact.length === 1) {
      let full: IIntervalsActivity;
      try {
        full = await intervalsApiService.getActivity(accessToken, exact[0].id);
      } catch (err) {
        logger.error({ err, intervalsActivityId: exact[0].id }, "intervals.icu getActivity failed");
        full = exact[0];
      }
      await commitLink(context.db, activity.id, full, processHeartRate);
      return { localActivityId: activity.id, intervalsActivityId: full.id };
    }
  }

  const fuzzy = candidates.filter((candidate) => {
    const candidateStart = parseIntervalsLocalStartMs(candidate.start_date_local);
    if (Number.isNaN(candidateStart)) return false;
    return withinMatchTolerance(
      candidateStart,
      candidate.distance,
      localStartMs,
      activity.distance,
    );
  });
  if (fuzzy.length !== 1) return null;

  let full: IIntervalsActivity;
  try {
    full = await intervalsApiService.getActivity(accessToken, fuzzy[0].id);
  } catch (err) {
    logger.error({ err, intervalsActivityId: fuzzy[0].id }, "intervals.icu getActivity failed");
    full = fuzzy[0];
  }

  await commitLink(context.db, activity.id, full, processHeartRate);
  return { localActivityId: activity.id, intervalsActivityId: full.id };
}

export async function enrichActivityFromIntervalsIcu(
  context: IGlobalBindings,
  user: { id: string },
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
    accessToken = await getIntervalsAccessToken(user.id);
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

  const processHeartRate = await userHasHeartRateConsent(context.db, user.id);
  await context.db
    .update(activities)
    .set({
      intervalsIcuEnrichedAt: new Date(),
      ...buildEnrichment(full, processHeartRate),
    })
    .where(eq(activities.id, activity.id));

  return "enriched";
}

const SYNC_THROTTLE_MS = 100;
const INTERVALS_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

const SYNC_KIND = "intervals_master_sync";
const SYNC_TITLE = "intervals.icu";

export interface SyncIntervalsResult {
  candidates: number;
  linked: number;
  noMatch: number;
  failed: number;
}

const AUTO_ANALYZE_ON_IMPORT = false;

const MASTER_WINDOW_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const MASTER_HISTORY_FLOOR_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface MasterSyncResult extends SyncIntervalsResult {
  created: number;
  processed: number;
}

type FuzzyLocal = {
  id: number;
  startMs: number;
  distance: number;
  stravaActivityId: number | null;
};

function findUniqueInMemoryMatch(
  intervalsActivity: IIntervalsActivity,
  locals: FuzzyLocal[],
): FuzzyLocal | null {
  if (intervalsActivity.strava_id != null) {
    const exact = locals.filter((l) => l.stravaActivityId === intervalsActivity.strava_id);
    if (exact.length === 1) return exact[0];
  }

  const startMs = parseIntervalsLocalStartMs(intervalsActivity.start_date_local);
  if (Number.isNaN(startMs)) return null;

  let found: FuzzyLocal | null = null;
  for (const local of locals) {
    if (withinMatchTolerance(startMs, intervalsActivity.distance, local.startMs, local.distance)) {
      if (found) return null;
      found = local;
    }
  }
  return found;
}

function intervalsCompletedMessage(
  r: MasterSyncResult,
  retryAt?: number,
): { messageKey: string; messageArgs: Record<string, string> } {
  if (retryAt) {
    return { messageKey: "sync_completed_rate_limited", messageArgs: { provider: SYNC_TITLE } };
  }
  if (r.created + r.linked === 0) {
    return {
      messageKey: r.failed > 0 ? "sync_completed_errors" : "sync_completed_up_to_date",
      messageArgs: { provider: SYNC_TITLE },
    };
  }
  return {
    messageKey: "sync_completed_intervals",
    messageArgs: { created: String(r.created), linked: String(r.linked) },
  };
}

export async function syncAllFromIntervals(
  context: IGlobalBindings,
  user: { id: string },
): Promise<MasterSyncResult> {
  const result: MasterSyncResult = {
    candidates: 0,
    linked: 0,
    noMatch: 0,
    failed: 0,
    created: 0,
    processed: 0,
  };

  let retryAt: number | undefined;

  await publishSync(user.id, {
    kind: SYNC_KIND,
    phase: "started",
    title: SYNC_TITLE,
  });

  try {
    const accessToken = await getIntervalsAccessToken(user.id);
    const processHeartRate = await userHasHeartRateConsent(context.db, user.id);

    const localRows = await context.db
      .select({
        id: activities.id,
        startDateLocal: activities.startDateLocal,
        distance: activities.distance,
        intervalsIcuId: activities.intervalsIcuId,
        stravaActivityId: activities.stravaActivityId,
      })
      .from(activities)
      .where(eq(activities.userId, user.id));

    const knownIntervalsIds = new Set<string>();
    const unlinkedLocals: FuzzyLocal[] = [];
    for (const row of localRows) {
      if (row.intervalsIcuId) {
        knownIntervalsIds.add(row.intervalsIcuId);
      } else {
        unlinkedLocals.push({
          id: row.id,
          startMs: row.startDateLocal.getTime(),
          distance: row.distance,
          stravaActivityId: row.stravaActivityId,
        });
      }
    }

    const seen = new Set<string>();
    const floorMs = Date.now() - MASTER_HISTORY_FLOOR_MS;
    let windowNewestMs = Date.now();

    while (windowNewestMs > floorMs) {
      const windowOldestMs = windowNewestMs - MASTER_WINDOW_MS;
      const oldest = new Date(windowOldestMs).toISOString().slice(0, 10);
      const newest = new Date(windowNewestMs).toISOString().slice(0, 10);

      let windowActivities: IIntervalsActivity[];
      try {
        windowActivities = await intervalsApiService.listActivities(accessToken, oldest, newest);
      } catch (err) {
        logger.error({ err, oldest, newest }, "intervals.icu master sync window failed");
        result.failed++;
        if (err instanceof IntervalsError && err.status === 429) {
          retryAt = Date.now() + INTERVALS_RATE_LIMIT_COOLDOWN_MS;
          break;
        }
        windowNewestMs = windowOldestMs;
        await sleep(SYNC_THROTTLE_MS);
        continue;
      }

      if (windowActivities.length === 0) break;

      await publishSync(user.id, {
        kind: SYNC_KIND,
        phase: "progress",
        title: SYNC_TITLE,
        messageKey: "sync_scanning_window",
        messageArgs: {
          period: newest.slice(0, 7),
          imported: String(result.created),
          linked: String(result.linked),
        },
      });

      for (const intervalsActivity of windowActivities) {
        if (seen.has(intervalsActivity.id)) continue;
        seen.add(intervalsActivity.id);

        if (knownIntervalsIds.has(intervalsActivity.id)) continue;
        result.candidates++;

        try {
          const localMatch = findUniqueInMemoryMatch(intervalsActivity, unlinkedLocals);
          if (localMatch) {
            let full = intervalsActivity;
            try {
              full = await intervalsApiService.getActivity(accessToken, intervalsActivity.id);
            } catch (err) {
              logger.warn(
                { err, intervalsActivityId: intervalsActivity.id },
                "intervals.icu getActivity failed during master sync — using list payload",
              );
            }
            await commitLink(context.db, localMatch.id, full, processHeartRate);
            knownIntervalsIds.add(intervalsActivity.id);
            const idx = unlinkedLocals.indexOf(localMatch);
            if (idx >= 0) unlinkedLocals.splice(idx, 1);
            result.linked++;
          } else {
            const payload: InsertActivity = {
              ...mapIntervalsActivityToInsert(intervalsActivity, user.id, processHeartRate),
              intervalsAnalyzed: true,
              intervalsIcuEnrichedAt: new Date(),
              analysisStatus: AUTO_ANALYZE_ON_IMPORT ? "pending" : "completed",
              ...buildEnrichment(intervalsActivity, processHeartRate),
            };
            await context.db.insert(activities).values(payload).onConflictDoNothing();
            knownIntervalsIds.add(intervalsActivity.id);
            result.created++;
          }
        } catch (err) {
          result.failed++;
          logger.error(
            { err, intervalsActivityId: intervalsActivity.id },
            "intervals.icu master sync failed for activity",
          );
        }

        result.processed++;
      }

      windowNewestMs = windowOldestMs;
      await sleep(SYNC_THROTTLE_MS);
    }

    result.noMatch = result.candidates - result.linked - result.created;
  } catch (err) {
    result.failed++;
    logger.error({ err, userId: user.id }, "intervals.icu master sync failed");
  } finally {
    await publishSync(user.id, {
      kind: SYNC_KIND,
      phase: "completed",
      title: SYNC_TITLE,
      ...intervalsCompletedMessage(result, retryAt),
      retryAt,
    });
  }

  return result;
}

export async function disconnectIntervals(context: IGlobalBindings, userId: string): Promise<void> {
  const [row] = await context.db
    .update(users)
    .set({ intervalsAthleteId: null })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (row) await deleteProviderToken(context.db, row.id, "intervals");
}

export async function handleIntervalsScopeChange(
  context: IGlobalBindings,
  user: { id: string },
): Promise<"disconnected" | "still_valid" | "already_disconnected"> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch {
    return "already_disconnected";
  }

  try {
    await intervalsApiService.getAthlete(accessToken);
    return "still_valid";
  } catch (err) {
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      await disconnectIntervals(context, user.id);
      return "disconnected";
    }
    throw err;
  }
}
