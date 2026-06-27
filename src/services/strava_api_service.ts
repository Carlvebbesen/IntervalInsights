import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { StravaError } from "../error";
import { logger } from "../logger";
import { tracedFetch } from "../otel";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type {
  DetailedActivity,
  DetailedAthlete,
  Gear,
  Lap,
  SummaryActivity,
} from "../types/strava/IDetailedActivity";
import type { StreamTypeMap } from "../types/strava/IStream";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { publishSync } from "./progress_service";
import { getDbInsertActivity } from "./strava_mappers";

export interface StravaRateLimit {
  shortTermUsage: number;
  shortTermLimit: number;
  dailyUsage: number;
  dailyLimit: number;
}

function parseRateLimit(headers: Headers): StravaRateLimit | null {
  const usage = headers.get("x-readratelimit-usage") ?? headers.get("x-ratelimit-usage");
  const limit = headers.get("x-readratelimit-limit") ?? headers.get("x-ratelimit-limit");
  if (!usage || !limit) return null;
  const [su, du] = usage.split(",").map((v) => Number(v.trim()));
  const [sl, dl] = limit.split(",").map((v) => Number(v.trim()));
  if ([su, du, sl, dl].some((n) => Number.isNaN(n))) return null;
  return { shortTermUsage: su, shortTermLimit: sl, dailyUsage: du, dailyLimit: dl };
}

async function fetchStravaWithMeta<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<{ data: T; rateLimit: StravaRateLimit | null }> {
  const url = new URL(`https://www.strava.com/api/v3${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.append(key, value);
    });
  }
  logger.debug({ url: url.toString() }, "Strava API call");
  const response = await tracedFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new StravaError(response.status, errorData);
  }

  return {
    data: (await response.json()) as T,
    rateLimit: parseRateLimit(response.headers),
  };
}

async function fetchStrava<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
  const { data } = await fetchStravaWithMeta<T>(endpoint, accessToken, params);
  return data;
}

export const stravaApiService = {
  async getActivity(accessToken: string, id: number, includeEfforts?: string) {
    return fetchStrava<DetailedActivity>(
      `/activities/${id}`,
      accessToken,
      includeEfforts
        ? {
            include_all_efforts: includeEfforts,
          }
        : {},
    );
  },
  async getGear(accessToken: string, id: string) {
    return fetchStrava<Gear>(`/gear/${id}`, accessToken);
  },

  async getAthlete(accessToken: string) {
    return fetchStrava<DetailedAthlete>("/athlete", accessToken);
  },

  async getActivityStreams<K extends keyof StreamTypeMap>(
    accessToken: string,
    id: number,
    keys: K[],
  ): Promise<Pick<StreamTypeMap, K>> {
    const keysString = keys.join(",");
    return fetchStrava<Pick<StreamTypeMap, K>>(`/activities/${id}/streams`, accessToken, {
      keys: keysString,
      key_by_type: "true",
    });
  },

  async getActivityLaps(accessToken: string, id: number) {
    return fetchStrava<Lap[]>(`/activities/${id}/laps`, accessToken);
  },

  async listAthleteActivities(
    accessToken: string,
    query: { before?: string; after?: string; page?: string; per_page?: string },
  ) {
    return fetchStrava<SummaryActivity[]>("/athlete/activities", accessToken, query);
  },
  async listAthleteActivitiesWithMeta(
    accessToken: string,
    query: { before?: string; after?: string; page?: string; per_page?: string },
  ) {
    return fetchStravaWithMeta<SummaryActivity[]>("/athlete/activities", accessToken, query);
  },
  async getActivityWithMeta(accessToken: string, id: number) {
    return fetchStravaWithMeta<DetailedActivity>(`/activities/${id}`, accessToken, {});
  },
  async syncStravaActivities(
    accessToken: string,
    userId: string,
    ids: number[],
    db: IGlobalBindings["db"],
    onActivitySynced?: (internalId: number, stravaActivityId: number) => void,
  ) {
    const BATCH_SIZE = 5;
    const PROGRESS_EVERY = 10;
    const results = [];
    const triggers: Array<{ internalId: number; stravaActivityId: number }> = [];
    const processHeartRate = await userHasHeartRateConsent(db, userId);

    await publishSync(userId, {
      kind: "strava_import",
      phase: "started",
      title: "Strava",
      messageKey: "sync_importing",
      messageArgs: { done: "0", total: String(ids.length) },
    });

    let processed = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (id) => {
        try {
          const activity = await this.getActivity(accessToken, id);
          const values = getDbInsertActivity(activity, userId, processHeartRate);

          // Converge with an existing intervals.icu-sourced row for the same
          // workout (it carries this Strava id in intervalsStravaId but isn't
          // Strava-linked yet) instead of inserting a cross-source duplicate.
          // Mirrors the Strava webhook merge. The list endpoint already filters
          // these out, but a twin can appear between list and import, so guard
          // here too. intervals enrichment fields are left untouched.
          const twin = await db.query.activities.findFirst({
            where: (a, { and, eq, isNull }) =>
              and(
                eq(a.userId, userId),
                eq(a.intervalsStravaId, activity.id),
                isNull(a.stravaActivityId),
              ),
            columns: { id: true },
          });

          let internalId: number | undefined;
          if (twin) {
            await db
              .update(activities)
              .set({ ...values, analysisStatus: "pending" })
              .where(eq(activities.id, twin.id));
            internalId = twin.id;
          } else {
            const [inserted] = await db
              .insert(activities)
              .values(values)
              .onConflictDoNothing()
              .returning({ id: activities.id });
            internalId = inserted?.id;
            if (internalId == null) {
              const [row] = await db
                .select({ id: activities.id })
                .from(activities)
                .where(eq(activities.stravaActivityId, activity.id))
                .limit(1);
              internalId = row?.id;
            }
          }
          if (onActivitySynced && internalId != null) {
            triggers.push({ internalId, stravaActivityId: activity.id });
          }
          return { id, status: "success" };
        } catch (err) {
          logger.error({ err, stravaActivityId: id }, "Failed to sync activity");
          return { id, status: "failed", error: err };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      processed += batchResults.length;
      failed += batchResults.filter((r) => r.status === "failed").length;
      if (processed % PROGRESS_EVERY < BATCH_SIZE && processed < ids.length) {
        await publishSync(userId, {
          kind: "strava_import",
          phase: "progress",
          title: "Strava",
          messageKey: "sync_importing",
          messageArgs: { done: String(processed), total: String(ids.length) },
        });
      }
    }

    await publishSync(userId, {
      kind: "strava_import",
      phase: "completed",
      title: "Strava",
      messageKey: failed > 0 ? "sync_import_done_failed" : "sync_import_done",
      messageArgs: failed > 0
        ? { done: String(processed - failed), total: String(ids.length), failed: String(failed) }
        : { done: String(processed) },
    });

    // Stagger LLM-triggering analyses to avoid bursting Gemini's RPM quota on
    // large bulk imports. Fire-and-forget so the HTTP response returns promptly.
    if (onActivitySynced && triggers.length > 0) {
      const STAGGER_MS = 5000;
      void (async () => {
        for (let i = 0; i < triggers.length; i++) {
          onActivitySynced(triggers[i].internalId, triggers[i].stravaActivityId);
          if (i < triggers.length - 1) await sleep(STAGGER_MS);
        }
      })();
    }

    return results;
  },
};
