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

// Every intervals.icu call leaves the backend from one IP, which intervals.icu
// caps at 10 req/s. Serialize the *start* of each request to a minimum spacing so
// bursts — the master backfill's per-activity getActivity loop, or many webhooks
// firing at once — stay under that ceiling. JS is single-threaded, so the
// read-and-bump of `nextSlotMs` below is atomic: concurrent callers are handed
// sequential, non-overlapping slots. Heavy callers are sequential `await` loops,
// so each holds at most one slot at a time and interactive requests interleave
// fairly rather than queueing behind a whole backfill.
const MIN_REQUEST_SPACING_MS = 120; // ~8.3 req/s, headroom under the 10/s IP cap
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 6 * 60 * 1000; // beyond this, surface the 429 to the caller

let nextSlotMs = 0;

async function acquirePacingSlot(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextSlotMs);
  nextSlotMs = startAt + MIN_REQUEST_SPACING_MS;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

// intervals.icu sends `Retry-After` in whole seconds on a 429. Fall back to
// exponential backoff (1s, 2s, 4s) when the header is missing or unparseable.
function rateLimitBackoffMs(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return 2 ** attempt * 1000;
}

// intervals.icu stream `type` keys mirror Strava's. This is the full set the
// analysis pipeline consumes; callers may override with a narrower list.
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
      // intervals.icu accepts repeated query params (e.g. `curves`); an array
      // value is appended once per element, a string once.
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
    // intervals.icu returns a wrapper object (e.g. { icu_intervals: [...], ... })
    // here, not a bare array — caller must normalize.
    return fetchIntervals<unknown>(`/activity/${activityId}/intervals`, accessToken);
  },

  async getActivityStreams(
    accessToken: string,
    activityId: string,
    types: readonly string[] = DEFAULT_INTERVALS_STREAM_TYPES,
  ) {
    // intervals.icu returns an array of { type, data } stream objects — caller
    // must normalize into the internal StreamSet shape. Types absent for a
    // given activity are simply omitted from the response array.
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
