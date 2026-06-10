import { IntervalsError } from "../error";
import { tracedFetch } from "../otel";
import type {
  IIntervalsActivity,
  IIntervalsAthlete,
  IIntervalsPowerCurve,
} from "../types/intervals/IIntervalsActivity";
import type { IIntervalsWellness } from "../types/intervals/IIntervalsWellness";

const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";
const INTERVALS_FETCH_TIMEOUT_MS = 8000;

async function fetchIntervals<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string | string[]>,
): Promise<T> {
  const url = new URL(`${INTERVALS_BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      // intervals.icu accepts repeated query params (e.g. `curves`); an array
      // value is appended once per element, a string once.
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v) url.searchParams.append(key, v);
      }
    });
  }

  let response: Response;
  try {
    response = await tracedFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(INTERVALS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new IntervalsError(504, {
        message: `intervals.icu timed out on ${endpoint}`,
      });
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new IntervalsError(response.status, errorData);
  }

  return response.json() as Promise<T>;
}

export const intervalsApiService = {
  async getAthlete(accessToken: string) {
    return fetchIntervals<IIntervalsAthlete>("/athlete/0", accessToken);
  },

  async getActivity(accessToken: string, activityId: string) {
    return fetchIntervals<IIntervalsActivity>(`/activity/${activityId}`, accessToken);
  },

  async getActivityIntervals(accessToken: string, activityId: string) {
    // intervals.icu returns a wrapper object (e.g. { icu_intervals: [...], ... })
    // here, not a bare array — caller must normalize.
    return fetchIntervals<unknown>(`/activity/${activityId}/intervals`, accessToken);
  },

  async getActivityStreams(accessToken: string, activityId: string) {
    // intervals.icu returns an array of { type, data } stream objects — caller
    // must normalize into the { heartrate, time } shape it needs.
    return fetchIntervals<unknown>(`/activity/${activityId}/streams`, accessToken, {
      types: "heartrate,time",
    });
  },

  async listActivities(accessToken: string, oldest: string, newest: string) {
    return fetchIntervals<IIntervalsActivity[]>("/athlete/0/activities", accessToken, {
      oldest,
      newest,
    });
  },

  async getWellness(accessToken: string, oldest: string, newest: string) {
    return fetchIntervals<IIntervalsWellness[]>("/athlete/0/wellness", accessToken, {
      oldest,
      newest,
    });
  },

  // Best-effort curves (power for cycling, pace/running-power where available)
  // for the requested `curves` codes (e.g. `s0` = this season, `r.<from>.<to>`
  // = a custom date range) and activity `type`.
  async getPowerCurves(accessToken: string, curves: string[], type: string) {
    return fetchIntervals<IIntervalsPowerCurve[]>("/athlete/0/power-curves", accessToken, {
      curves,
      type,
    });
  },
};
