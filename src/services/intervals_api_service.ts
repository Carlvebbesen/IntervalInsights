import { sleep } from "bun";
import { IntervalsError } from "../error";
import { logger } from "../logger";
import { tracedFetch } from "../otel";
import type {
  IIntervalsActivity,
  IIntervalsAthlete,
  IIntervalsPowerCurve,
} from "../types/intervals/IIntervalsActivity";
import type { IIntervalsWellness } from "../types/intervals/IIntervalsWellness";

const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";
const INTERVALS_FETCH_TIMEOUT_MS = 8000;

const MIN_REQUEST_SPACING_MS = 120;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 6 * 60 * 1000;

let nextSlotMs = 0;

async function acquirePacingSlot(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextSlotMs);
  nextSlotMs = startAt + MIN_REQUEST_SPACING_MS;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

function rateLimitBackoffMs(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return 2 ** attempt * 1000;
}

export const DEFAULT_INTERVALS_STREAM_TYPES = [
  "time",
  "heartrate",
  "watts",
  "velocity_smooth",
  "distance",
  "altitude",
  "cadence",
  "latlng",
] as const;

async function fetchIntervals<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string | string[]>,
): Promise<T> {
  const url = new URL(`${INTERVALS_BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v) url.searchParams.append(key, v);
      }
    });
  }

  for (let attempt = 0; ; attempt++) {
    await acquirePacingSlot();

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

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = rateLimitBackoffMs(response, attempt);
      if (waitMs <= MAX_RETRY_AFTER_MS) {
        logger.warn(
          {
            endpoint,
            attempt,
            waitMs,
            remaining: response.headers.get("X-RateLimit-Remaining"),
          },
          "intervals.icu rate limited — backing off then retrying",
        );
        await sleep(waitMs);
        continue;
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new IntervalsError(response.status, errorData);
    }

    return response.json() as Promise<T>;
  }
}

export const intervalsApiService = {
  async getAthlete(accessToken: string) {
    return fetchIntervals<IIntervalsAthlete>("/athlete/0", accessToken);
  },

  async getActivity(accessToken: string, activityId: string) {
    return fetchIntervals<IIntervalsActivity>(`/activity/${activityId}`, accessToken);
  },

  async getActivityIntervals(accessToken: string, activityId: string) {
    return fetchIntervals<unknown>(`/activity/${activityId}/intervals`, accessToken);
  },

  async getActivityStreams(
    accessToken: string,
    activityId: string,
    types: readonly string[] = DEFAULT_INTERVALS_STREAM_TYPES,
  ) {
    return fetchIntervals<unknown>(`/activity/${activityId}/streams`, accessToken, {
      types: types.join(","),
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

  async getPowerCurves(accessToken: string, curves: string[], type: string) {
    return fetchIntervals<IIntervalsPowerCurve[]>("/athlete/0/power-curves", accessToken, {
      curves,
      type,
    });
  },
};
