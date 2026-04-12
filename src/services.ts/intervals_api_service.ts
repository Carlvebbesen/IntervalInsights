import { IntervalsError } from "../error";
import type {
  IIntervalsActivity,
  IIntervalsAthlete,
  IIntervalsInterval,
} from "../types/intervals/IIntervalsActivity";
import type {
  IIntervalsFitnessEvent,
  IIntervalsWellness,
} from "../types/intervals/IIntervalsWellness";

const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

async function fetchIntervals<T>(
  endpoint: string,
  apiKey: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${INTERVALS_BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.append(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new IntervalsError(response.status, errorData);
  }

  return response.json() as Promise<T>;
}

export const intervalsApiService = {
  async getAthlete(apiKey: string) {
    return fetchIntervals<IIntervalsAthlete>("/athlete/0", apiKey);
  },

  async getActivity(apiKey: string, activityId: string) {
    return fetchIntervals<IIntervalsActivity>(`/activity/${activityId}`, apiKey);
  },

  async getActivityStreams(apiKey: string, activityId: string) {
    return fetchIntervals<Record<string, number[]>>(`/activity/${activityId}/streams`, apiKey);
  },

  async getActivityIntervals(apiKey: string, activityId: string) {
    return fetchIntervals<IIntervalsInterval[]>(`/activity/${activityId}/intervals`, apiKey);
  },

  async getActivityPaceCurve(apiKey: string, activityId: string) {
    return fetchIntervals<number[]>(`/activity/${activityId}/pace-curve`, apiKey);
  },

  async getActivityHrCurve(apiKey: string, activityId: string) {
    return fetchIntervals<number[]>(`/activity/${activityId}/hr-curve`, apiKey);
  },

  async listActivities(apiKey: string, oldest: string, newest: string) {
    return fetchIntervals<IIntervalsActivity[]>("/athlete/0/activities", apiKey, { oldest, newest });
  },

  async getWellness(apiKey: string, oldest: string, newest: string) {
    return fetchIntervals<IIntervalsWellness[]>("/athlete/0/wellness", apiKey, { oldest, newest });
  },

  async getFitnessModel(apiKey: string, oldest: string, newest: string) {
    return fetchIntervals<IIntervalsFitnessEvent[]>("/athlete/0/fitness-model-events", apiKey, { oldest, newest });
  },

  async getPaceCurves(apiKey: string, params?: Record<string, string>) {
    return fetchIntervals<number[]>("/athlete/0/pace-curves", apiKey, params);
  },

  async getSportSettings(apiKey: string) {
    return fetchIntervals<Record<string, unknown>[]>("/athlete/0/sport-settings", apiKey);
  },
};
