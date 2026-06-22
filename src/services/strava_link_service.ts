import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { StravaError } from "../error";
import { logger } from "../logger";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { SummaryActivity } from "../types/strava/IDetailedActivity";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { progressService } from "./progress_service";
import { type StravaRateLimit, stravaApiService } from "./strava_api_service";
import { getDbInsertFromSummary } from "./strava_mappers";

// Strava's rate limit is strict, so the master sync is built around it:
//   1. One cheap paginated list pass backfills title + gear (both present on the
//      summary) and links/creates rows — a few requests for two years.
//   2. A second pass fetches descriptions (detail-only, one request each),
//      throttled and stopped early when Strava's short-term budget runs low.
//      Anything left over is reported as `descriptionsRemaining` and picked up
//      on the next run.
//
// The caller runs this in the background (fire-and-forget) and the client
// follows along on the SSE progress channel, so this function never throws:
// it always emits a `started` then a `completed` event and returns its counts.

const LOOKBACK_YEARS = 2;
const PAGE_SIZE = 200;
const MAX_LIST_PAGES = 60;
const LIST_THROTTLE_MS = 200;
const DETAIL_THROTTLE_MS = 250;
// Leave headroom under the 15-minute window so a concurrent webhook/import
// doesn't tip us into a 429.
const SHORT_TERM_SAFETY_MARGIN = 10;
// Hard cap so a single run stays bounded in wall-clock time.
const MAX_DESCRIPTION_FETCHES = 200;
const PROGRESS_EVERY = 25;

const TIME_TOLERANCE_MS = 5 * 60 * 1000;
const DISTANCE_TOLERANCE_RATIO = 0.03;

export interface StravaMasterSyncResult {
  processed: number;
  created: number;
  linked: number;
  updated: number;
  descriptionsUpdated: number;
  descriptionsRemaining: number;
  failed: number;
}

type FuzzyLocal = { id: number; startMs: number; distance: number; hasDescription: boolean };

function findUniqueMatch(summary: SummaryActivity, locals: FuzzyLocal[]): FuzzyLocal | null {
  const startMs = new Date(summary.start_date_local).getTime();
  if (Number.isNaN(startMs) || summary.distance == null) return null;

  const minDistance = summary.distance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = summary.distance * (1 + DISTANCE_TOLERANCE_RATIO);

  let found: FuzzyLocal | null = null;
  for (const local of locals) {
    if (Math.abs(startMs - local.startMs) > TIME_TOLERANCE_MS) continue;
    if (local.distance < minDistance || local.distance > maxDistance) continue;
    if (found) return null; // ambiguous → skip
    found = local;
  }
  return found;
}

function overBudget(rateLimit: StravaRateLimit | null): boolean {
  if (!rateLimit) return false;
  return rateLimit.shortTermUsage >= rateLimit.shortTermLimit - SHORT_TERM_SAFETY_MARGIN;
}

export async function syncAllFromStrava(
  context: IGlobalBindings,
  accessToken: string,
  user: { id: string },
): Promise<StravaMasterSyncResult> {
  const result: StravaMasterSyncResult = {
    processed: 0,
    created: 0,
    linked: 0,
    updated: 0,
    descriptionsUpdated: 0,
    descriptionsRemaining: 0,
    failed: 0,
  };

  await progressService.publish(user.id, {
    type: "sync",
    data: { kind: "strava_master_sync", phase: "started", processed: 0 },
  });

  try {
    const processHeartRate = await userHasHeartRateConsent(context.db, user.id);

    const localRows = await context.db
      .select({
        id: activities.id,
        startDateLocal: activities.startDateLocal,
        distance: activities.distance,
        stravaActivityId: activities.stravaActivityId,
        description: activities.description,
      })
      .from(activities)
      .where(eq(activities.userId, user.id));

    const stravaIdToLocalId = new Map<number, number>();
    const unlinkedLocals: FuzzyLocal[] = [];
    for (const row of localRows) {
      if (row.stravaActivityId != null) {
        stravaIdToLocalId.set(Number(row.stravaActivityId), row.id);
      } else {
        unlinkedLocals.push({
          id: row.id,
          startMs: row.startDateLocal.getTime(),
          distance: row.distance,
          hasDescription: !!row.description?.trim(),
        });
      }
    }

    // Rows whose description should be fetched in the second pass.
    const descriptionQueue: Array<{ internalId: number; stravaId: number }> = [];
    const afterEpoch = Math.floor(
      (Date.now() - LOOKBACK_YEARS * 365 * 24 * 60 * 60 * 1000) / 1000,
    );
    const seen = new Set<number>();
    let lastRateLimit: StravaRateLimit | null = null;

    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      let summaries: SummaryActivity[];
      try {
        const res = await stravaApiService.listAthleteActivitiesWithMeta(accessToken, {
          after: String(afterEpoch),
          page: String(page),
          per_page: String(PAGE_SIZE),
        });
        summaries = res.data;
        lastRateLimit = res.rateLimit;
      } catch (err) {
        logger.error({ err, page }, "Strava master sync list page failed");
        result.failed++;
        break;
      }

      if (summaries.length === 0) break;

      for (const summary of summaries) {
        if (seen.has(summary.id)) continue;
        seen.add(summary.id);
        result.processed++;

        try {
          const existingId = stravaIdToLocalId.get(summary.id);
          if (existingId != null) {
            // Already linked by Strava id — refresh title + gear (Strava wins).
            await context.db
              .update(activities)
              .set({ title: summary.name, gearId: summary.gear_id })
              .where(eq(activities.id, existingId));
            result.updated++;
            const row = localRows.find((r) => r.id === existingId);
            if (!row?.description?.trim()) {
              descriptionQueue.push({ internalId: existingId, stravaId: summary.id });
            }
            continue;
          }

          const match = findUniqueMatch(summary, unlinkedLocals);
          if (match) {
            await context.db
              .update(activities)
              .set({ stravaActivityId: summary.id, title: summary.name, gearId: summary.gear_id })
              .where(eq(activities.id, match.id));
            stravaIdToLocalId.set(summary.id, match.id);
            unlinkedLocals.splice(unlinkedLocals.indexOf(match), 1);
            result.linked++;
            if (!match.hasDescription) {
              descriptionQueue.push({ internalId: match.id, stravaId: summary.id });
            }
            continue;
          }

          const [inserted] = await context.db
            .insert(activities)
            .values({
              ...getDbInsertFromSummary(summary, user.id, processHeartRate),
              analysisStatus: "completed",
            })
            .onConflictDoNothing()
            .returning({ id: activities.id });
          if (inserted) {
            stravaIdToLocalId.set(summary.id, inserted.id);
            result.created++;
            descriptionQueue.push({ internalId: inserted.id, stravaId: summary.id });
          }
        } catch (err) {
          result.failed++;
          logger.error(
            { err, stravaActivityId: summary.id },
            "Strava master sync failed for activity",
          );
        }

        if (result.processed % PROGRESS_EVERY === 0) {
          await progressService.publish(user.id, {
            type: "sync",
            data: {
              kind: "strava_master_sync",
              phase: "progress",
              processed: result.processed,
              created: result.created,
              linked: result.linked,
              updated: result.updated,
              failed: result.failed,
            },
          });
        }
      }

      if (summaries.length < PAGE_SIZE) break;
      await sleep(LIST_THROTTLE_MS);
    }

    // Second pass: descriptions (detail-only), bounded by the rate-limit budget.
    let i = 0;
    for (; i < descriptionQueue.length; i++) {
      if (i >= MAX_DESCRIPTION_FETCHES || overBudget(lastRateLimit)) break;
      const item = descriptionQueue[i];
      try {
        const { data, rateLimit } = await stravaApiService.getActivityWithMeta(
          accessToken,
          item.stravaId,
        );
        if (rateLimit) lastRateLimit = rateLimit;
        if (data.description?.trim()) {
          await context.db
            .update(activities)
            .set({ description: data.description })
            .where(eq(activities.id, item.internalId));
          result.descriptionsUpdated++;
        }
      } catch (err) {
        if (err instanceof StravaError && err.status === 429) {
          logger.warn({ stravaActivityId: item.stravaId }, "Strava 429 — stopping description pass");
          break;
        }
        result.failed++;
        logger.error({ err, stravaActivityId: item.stravaId }, "Strava description fetch failed");
      }
      await sleep(DETAIL_THROTTLE_MS);
    }
    result.descriptionsRemaining = descriptionQueue.length - i;
  } catch (err) {
    result.failed++;
    logger.error({ err, userId: user.id }, "Strava master sync failed");
  } finally {
    await progressService.publish(user.id, {
      type: "sync",
      data: {
        kind: "strava_master_sync",
        phase: "completed",
        processed: result.processed,
        created: result.created,
        linked: result.linked,
        updated: result.updated,
        descriptionsUpdated: result.descriptionsUpdated,
        descriptionsRemaining: result.descriptionsRemaining,
        failed: result.failed,
      },
    });
  }

  return result;
}
