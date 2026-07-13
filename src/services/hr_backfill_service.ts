import { sleep } from "bun";
import { and, eq, isNull } from "drizzle-orm";
import { StravaError } from "../error";
import type { Logger } from "../logger";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import * as activityRepo from "../repositories/activity_repository";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { SummaryActivity } from "../types/strava/IDetailedActivity";
import { computeAndPersistRow } from "./heart_rate_analysis_service";
import { publishSync } from "./progress_service";
import { type StravaRateLimit, stravaApiService } from "./strava_api_service";
import { nextStravaWindowMs, overBudget } from "./strava_link_service";

const SYNC_KIND = "hr_backfill";
const SYNC_TITLE = "Heart rate";
const PAGE_SIZE = 200;
const MAX_LIST_PAGES = 20;
const MAX_STREAM_FETCHES_PER_RUN = 300;
const STREAM_THROTTLE_MS = 1000;
const LIST_THROTTLE_MS = 200;
const PROGRESS_EVERY = 25;

export interface HrBackfillResult {
  summaryUpdated: number;
  statsComputed: number;
  remaining: number;
  failed: number;
  retryAt?: number;
}

const activeBackfills = new Set<string>();

export function isHrBackfillRunning(userId: string): boolean {
  return activeBackfills.has(userId);
}

function hrBackfillCompletedMessage(
  r: HrBackfillResult,
  retryAt?: number,
): { messageKey: string; messageArgs: Record<string, string> } {
  if (retryAt) return { messageKey: "hr_backfill_completed_rate_limited", messageArgs: {} };
  if (r.remaining > 0) {
    return {
      messageKey: "hr_backfill_completed_more",
      messageArgs: { computed: String(r.statsComputed), remaining: String(r.remaining) },
    };
  }
  if (r.summaryUpdated + r.statsComputed === 0) {
    return { messageKey: "hr_backfill_completed_up_to_date", messageArgs: {} };
  }
  return {
    messageKey: "hr_backfill_completed",
    messageArgs: { computed: String(r.statsComputed) },
  };
}

export async function runHrBackfill(
  context: IGlobalBindings,
  userId: string,
  log: Logger,
): Promise<HrBackfillResult> {
  const result: HrBackfillResult = { summaryUpdated: 0, statsComputed: 0, remaining: 0, failed: 0 };
  let retryAt: number | undefined;

  activeBackfills.add(userId);
  await publishSync(userId, { kind: SYNC_KIND, phase: "started", title: SYNC_TITLE });

  try {
    let stravaToken: string | null = null;
    try {
      stravaToken = (await getStravaAccessTokens(userId)).access_token;
    } catch (err) {
      log.warn({ err }, "no Strava token for HR backfill");
    }

    result.summaryUpdated += await activityRepo.repairHasHeartrateFlag(context.db, userId);

    if (stravaToken) {
      const localRows = await context.db
        .select({
          id: activities.id,
          stravaActivityId: activities.stravaActivityId,
          intervalsStravaId: activities.intervalsStravaId,
        })
        .from(activities)
        .where(and(eq(activities.userId, userId), isNull(activities.averageHeartRate)));

      const byStravaId = new Map<number, { id: number }>();
      for (const row of localRows) {
        if (row.stravaActivityId != null) byStravaId.set(row.stravaActivityId, { id: row.id });
        if (row.intervalsStravaId != null) byStravaId.set(row.intervalsStravaId, { id: row.id });
      }

      let lastRateLimit: StravaRateLimit | null = null;
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        let summaries: SummaryActivity[];
        try {
          const res = await stravaApiService.listAthleteActivitiesWithMeta(stravaToken, {
            per_page: String(PAGE_SIZE),
            page: String(page),
          });
          summaries = res.data;
          lastRateLimit = res.rateLimit;
        } catch (err) {
          if (err instanceof StravaError && err.status === 429) retryAt = nextStravaWindowMs();
          else {
            result.failed++;
            log.error({ err, page }, "HR backfill Strava list page failed");
          }
          break;
        }

        for (const summary of summaries) {
          if (!(summary.has_heartrate && summary.average_heartrate != null)) continue;
          const local = byStravaId.get(summary.id);
          if (!local) continue;
          await activityRepo.updateSummaryHr(context.db, local.id, {
            averageHeartRate: summary.average_heartrate,
            maxHeartRate: summary.max_heartrate ?? null,
            hasHeartrate: true,
          });
          result.summaryUpdated++;
          byStravaId.delete(summary.id);
        }

        if (summaries.length < PAGE_SIZE) break;
        if (overBudget(lastRateLimit)) {
          retryAt = nextStravaWindowMs();
          break;
        }
        await sleep(LIST_THROTTLE_MS);
      }
    }

    const candidates = await activityRepo.listHrStatsBackfillCandidates(context.db, userId);
    let i = 0;
    for (; i < candidates.length && i < MAX_STREAM_FETCHES_PER_RUN; i++) {
      const row = candidates[i];
      try {
        await computeAndPersistRow(context.db, userId, row);
        result.statsComputed++;
      } catch (err) {
        if (err instanceof StravaError && err.status === 429) {
          retryAt ??= nextStravaWindowMs();
          break;
        }
        result.failed++;
        log.warn({ err, activityId: row.id }, "HR backfill stream computation failed");
      }
      await sleep(STREAM_THROTTLE_MS);
      if ((i + 1) % PROGRESS_EVERY === 0) {
        await publishSync(userId, {
          kind: SYNC_KIND,
          phase: "progress",
          title: SYNC_TITLE,
          messageKey: "hr_backfill_progress",
          messageArgs: { done: String(i + 1), total: String(candidates.length) },
        });
      }
    }
    result.remaining = candidates.length - i;
  } catch (err) {
    result.failed++;
    log.error({ err, userId }, "HR backfill failed");
  } finally {
    result.retryAt = retryAt;
    activeBackfills.delete(userId);
    await publishSync(userId, {
      kind: SYNC_KIND,
      phase: "completed",
      title: SYNC_TITLE,
      ...hrBackfillCompletedMessage(result, retryAt),
      retryAt,
    });
  }

  return result;
}
