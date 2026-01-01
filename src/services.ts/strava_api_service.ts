import { StravaError } from "../error";
import { activities, getDbInsertActivity } from "../schema";
import { IGlobalBindings } from "../types/IRouters";
import { DetailedActivity, Gear, Lap, SummaryActivity } from "../types/strava/IDetailedActivity";
import { StreamSet, StreamTypeMap } from "../types/strava/IStream";
import { triggerInitialAnalysis } from "./analysis_service";



// Helper to handle the actual fetch and common error logic
async function fetchStrava<T>(endpoint: string, accessToken: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`https://www.strava.com/api/v3${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.append(key, value);
    });
  }
  console.log(url.toString());
  const response = await fetch(url.toString(), {
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
    return fetchStrava<DetailedActivity>(`/activities/${id}`, accessToken, includeEfforts ?{
      include_all_efforts: includeEfforts,
    }: {});
  },
  async getGear(accessToken: string, id: string) {
    return fetchStrava<Gear>(`/gear/${id}`, accessToken);
  },

  async getActivityStreams<K extends keyof StreamTypeMap>(
    accessToken: string,
    id: number,
    keys: K[]
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

  async listAthleteActivities(accessToken: string, query: { before?: string; after?: string; page?: string; per_page?: string }) {
    return fetchStrava<SummaryActivity[]>("/athlete/activities", accessToken, query);
  },
  async syncStravaActivities(accessToken: string,userId: string, ids: number[], db: IGlobalBindings["db"]) {
    const BATCH_SIZE = 30;
    const results = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (id) => {
        try {
          const activity = await this.getActivity(accessToken, id);
          await db.insert(activities).values(getDbInsertActivity(activity, userId)).onConflictDoNothing();
           // TODO: fix this in the future
          triggerInitialAnalysis(db,accessToken, activity.id, activity);
          return { id, status: "success" };
        } catch (error) {
          console.error(`Failed to sync activity ${id}:`, error);
          return { id, status: "failed", error };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    return results;
  },
};