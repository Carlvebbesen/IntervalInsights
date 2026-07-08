import { sleep } from "bun";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { IntervalsError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { activities, type InsertActivity, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsActivity } from "../types/intervals/IIntervalsActivity";
import { intervalsApiService } from "./intervals_api_service";
import { mapIntervalsActivityToInsert } from "./intervals_mappers";
import { deleteProviderToken } from "./oauth_token_store";
import { publishSync } from "./progress_service";

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
  intervalsDistance: number | null,
  localStartMs: number,
  localDistance: number,
): boolean {
  const timeDelta = Math.abs(intervalsStartMs - localStartMs);
  if (timeDelta > TIME_TOLERANCE_MS) return false;
  if (intervalsDistance == null) return false;

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
  if (intervalsActivity.distance == null) return null;

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

  const match = await findLocalByFuzzyMatch(context, user.id, intervalsActivity);
  if (!match) return null;

  await commitLink(context, match.id, intervalsActivity);
  return { localActivityId: match.id, intervalsActivityId };
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

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.id);
  } catch (err) {
    // athleteId set on the user row but the stored token is missing/expired —
    // surface it; otherwise this is indistinguishable from "no match" and the
    // activity silently never links.
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

  // Exact join first: when both rows originate from the same Strava activity,
  // intervals.icu carries its `strava_id`. That's an unambiguous key — use it
  // before the fuzzy time/distance heuristic, which mis-fires on timezone-offset
  // start times and >3% distance drift between the two sources.
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
      await commitLink(context, activity.id, full);
      return { localActivityId: activity.id, intervalsActivityId: full.id };
    }
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

  await context.db
    .update(activities)
    .set({
      intervalsIcuEnrichedAt: new Date(),
      ...buildEnrichment(full),
    })
    .where(eq(activities.id, activity.id));

  return "enriched";
}

const SYNC_THROTTLE_MS = 100;
// intervalsApiService paces every request under the 10 req/s IP cap and retries
// transient 429s honouring Retry-After, so a 429 surfacing here means the limit
// is persistent (retries exhausted or the wait exceeded the layer's ceiling).
// We stop the backfill and report a resume point rather than hammering further.
const INTERVALS_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

const SYNC_KIND = "intervals_master_sync";
const SYNC_TITLE = "intervals.icu";

export interface SyncIntervalsResult {
  candidates: number;
  linked: number;
  noMatch: number;
  failed: number;
}

// Cost safety: historical activities pulled by the master sync must never
// trigger LLM analysis. Flip this to opt the import path back into analysis.
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
  // Exact Strava-id join first (see linkFromLocalActivity) — unambiguous when
  // both rows came from the same Strava activity.
  if (intervalsActivity.strava_id != null) {
    const exact = locals.filter((l) => l.stravaActivityId === intervalsActivity.strava_id);
    if (exact.length === 1) return exact[0];
  }

  const startMs = parseIntervalsLocalStartMs(intervalsActivity.start_date_local);
  if (Number.isNaN(startMs)) return null;

  let found: FuzzyLocal | null = null;
  for (const local of locals) {
    if (
      matchesByDistanceAndTime(startMs, intervalsActivity.distance, local.startMs, local.distance)
    ) {
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
            await commitLink(context, localMatch.id, full);
            knownIntervalsIds.add(intervalsActivity.id);
            const idx = unlinkedLocals.indexOf(localMatch);
            if (idx >= 0) unlinkedLocals.splice(idx, 1);
            result.linked++;
          } else {
            const payload: InsertActivity = {
              ...mapIntervalsActivityToInsert(intervalsActivity, user.id),
              intervalsAnalyzed: true,
              intervalsIcuEnrichedAt: new Date(),
              analysisStatus: AUTO_ANALYZE_ON_IMPORT ? "pending" : "completed",
              ...buildEnrichment(intervalsActivity),
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
