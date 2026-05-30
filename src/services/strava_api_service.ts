import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { StravaError } from "../error";
import { logger } from "../logger";
import { tracedFetch } from "../otel";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type {
  DetailedActivity,
  Gear,
  Lap,
  SummaryActivity,
} from "../types/strava/IDetailedActivity";
import type { StreamTypeMap } from "../types/strava/IStream";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { getDbInsertActivity } from "./strava_mappers";

async function fetchStrava<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
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

  return response.json() as Promise<T>;
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
  async syncStravaActivities(
    accessToken: string,
    userId: string,
    ids: number[],
    db: IGlobalBindings["db"],
    onActivitySynced?: (internalId: number, stravaActivityId: number) => void,
  ) {
    const BATCH_SIZE = 5;
    const results = [];
    const triggers: Array<{ internalId: number; stravaActivityId: number }> = [];
    const processHeartRate = await userHasHeartRateConsent(db, userId);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (id) => {
        try {
          const activity = await this.getActivity(accessToken, id);
          await db
            .insert(activities)
            .values(getDbInsertActivity(activity, userId, processHeartRate))
            .onConflictDoNothing();
          if (onActivitySynced) {
            const [row] = await db
              .select({ id: activities.id })
              .from(activities)
              .where(eq(activities.stravaActivityId, activity.id))
              .limit(1);
            if (row) triggers.push({ internalId: row.id, stravaActivityId: activity.id });
          }
          return { id, status: "success" };
        } catch (err) {
          logger.error({ err, stravaActivityId: id }, "Failed to sync activity");
          return { id, status: "failed", error: err };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

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
