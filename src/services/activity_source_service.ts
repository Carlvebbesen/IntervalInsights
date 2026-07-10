import { and, eq } from "drizzle-orm";
import { AppError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet, StreamTypeMap } from "../types/strava/IStream";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { intervalsApiService } from "./intervals_api_service";
import { mapIntervalsRawToLaps, mapIntervalsStreamsToStreamSet } from "./intervals_mappers";
import { stravaApiService } from "./strava_api_service";

type Db = IGlobalBindings["db"];

type ActivitySourceRow = { intervalsIcuId: string | null; stravaActivityId: number | null };

async function loadActivitySourceRow(
  db: Db,
  userId: string,
  activityId: number,
): Promise<ActivitySourceRow> {
  const row = await db.query.activities.findFirst({
    where: and(eq(activities.id, activityId), eq(activities.userId, userId)),
    columns: { intervalsIcuId: true, stravaActivityId: true },
  });
  if (!row) throw new AppError(404, "Activity not found");
  return row;
}

type FetchSource = "intervals" | "strava_fallback" | "strava";

/**
 * Shared intervals.icu-preferred fetch with whole-call Strava fallback, used by
 * both streams and laps so they fall back identically. intervals is tried when
 * `intervalsIcuId` is set and its token resolves; if the intervals token OR the
 * intervals fetch itself fails, the entire call falls back to Strava when a
 * `stravaActivityId` exists (no per-key/per-lap top-up). `source` distinguishes
 * a never-eligible Strava call (`strava`) from an intervals failure (`strava_fallback`).
 */
async function fetchIntervalsPreferred<T>(
  db: Db,
  userId: string,
  activityId: number,
  ops: {
    fromIntervals: (token: string, externalId: string) => Promise<T>;
    fromStrava: (token: string, externalId: number) => Promise<T>;
  },
): Promise<{ result: T; source: FetchSource }> {
  const row = await loadActivitySourceRow(db, userId, activityId);

  if (row.intervalsIcuId) {
    try {
      const token = await getIntervalsAccessToken(userId);
      return { result: await ops.fromIntervals(token, row.intervalsIcuId), source: "intervals" };
    } catch (err) {
      if (row.stravaActivityId == null) throw err;
      const tokens = await getStravaAccessTokens(userId);
      return {
        result: await ops.fromStrava(tokens.access_token, row.stravaActivityId),
        source: "strava_fallback",
      };
    }
  }
  if (row.stravaActivityId != null) {
    const tokens = await getStravaAccessTokens(userId);
    return {
      result: await ops.fromStrava(tokens.access_token, row.stravaActivityId),
      source: "strava",
    };
  }
  throw new AppError(400, "Activity has no intervals.icu or Strava source to fetch from");
}

/**
 * Resolves where an activity's time-series data should be fetched from,
 * intervals.icu-preferred (see the intervals-icu-primary-data-source decision).
 * Tokens are resolved lazily so these endpoints work for intervals-only users
 * who never linked Strava. Takes the INTERNAL activity id (not a Strava id).
 */
export type ActivitySource =
  | { kind: "intervals"; token: string; externalId: string }
  | { kind: "strava"; token: string; externalId: number };

export async function resolveActivitySource(
  db: Db,
  userId: string,
  activityId: number,
): Promise<ActivitySource> {
  const row = await loadActivitySourceRow(db, userId, activityId);

  if (row.intervalsIcuId) {
    try {
      const token = await getIntervalsAccessToken(userId);
      return { kind: "intervals", token, externalId: row.intervalsIcuId };
    } catch (err) {
      // intervals not linked / token dead — fall back to Strava if we can.
      if (row.stravaActivityId == null) throw err;
    }
  }
  if (row.stravaActivityId != null) {
    const tokens = await getStravaAccessTokens(userId);
    return { kind: "strava", token: tokens.access_token, externalId: row.stravaActivityId };
  }
  throw new AppError(400, "Activity has no intervals.icu or Strava source to fetch from");
}

export async function getLaps(db: Db, userId: string, activityId: number): Promise<Lap[]> {
  const { result, source } = await fetchIntervalsPreferred<Lap[]>(db, userId, activityId, {
    fromIntervals: async (token, externalId) =>
      mapIntervalsRawToLaps(await intervalsApiService.getActivityIntervals(token, externalId)),
    fromStrava: (token, externalId) => stravaApiService.getActivityLaps(token, externalId),
  });
  logger.info({ source, activityId }, "laps_fetch");
  return result;
}

export async function getSplits(db: Db, userId: string, activityId: number) {
  const src = await resolveActivitySource(db, userId, activityId);
  // intervals.icu has no per-km splits_metric equivalent; the app derives splits
  // in-app from the distance stream. Strava still provides them directly.
  if (src.kind === "intervals") return [];
  const activity = await stravaApiService.getActivity(src.token, src.externalId);
  return activity.splits_metric ?? [];
}

export async function getStreamSet<K extends keyof StreamTypeMap>(
  db: Db,
  userId: string,
  activityId: number,
  keys: readonly K[],
): Promise<Pick<StreamSet, K>> {
  const gateHeartRate =
    keys.includes("heartrate" as K) && !(await userHasHeartRateConsent(db, userId));
  const providerKeys = (
    gateHeartRate ? keys.filter((k) => k !== ("heartrate" as K)) : [...keys]
  ) as (keyof StreamTypeMap)[];

  const { result, source } = await fetchIntervalsPreferred<StreamSet>(db, userId, activityId, {
    fromIntervals: async (token, externalId) =>
      mapIntervalsStreamsToStreamSet(
        await intervalsApiService.getActivityStreams(token, externalId, providerKeys),
      ),
    fromStrava: (token, externalId) =>
      stravaApiService.getActivityStreams(token, externalId, providerKeys),
  });

  if (gateHeartRate) delete result.heartrate;

  logger.info({ source, keys: providerKeys, activityId }, "stream_fetch");
  return result as Pick<StreamSet, K>;
}

const DEFAULT_STREAM_KEYS = [
  "time",
  "distance",
  "altitude",
  "cadence",
  "velocity_smooth",
  "heartrate",
] as const;

export async function getStreams(db: Db, userId: string, activityId: number) {
  const streams = await getStreamSet(db, userId, activityId, DEFAULT_STREAM_KEYS);
  return {
    time: streams?.time?.data ?? [],
    distance: streams?.distance?.data ?? [],
    heartrate: streams?.heartrate?.data ?? null,
    altitude: streams?.altitude?.data ?? null,
    cadence: streams?.cadence?.data ?? null,
    velocity: streams?.velocity_smooth?.data ?? null,
  };
}
