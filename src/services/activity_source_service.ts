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
      logger.warn({ err, activityId }, "intervals fetch failed, falling back to strava");
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
  if (src.kind === "intervals") return [];
  const activity = await stravaApiService.getActivity(src.token, src.externalId);
  return activity.splits_metric ?? [];
}

async function resolveHeartRateGate<K extends keyof StreamTypeMap>(
  db: Db,
  userId: string,
  keys: readonly K[],
): Promise<{ gateHeartRate: boolean; providerKeys: (keyof StreamTypeMap)[] }> {
  const gateHeartRate =
    keys.includes("heartrate" as K) && !(await userHasHeartRateConsent(db, userId));
  const providerKeys = (
    gateHeartRate ? keys.filter((k) => k !== ("heartrate" as K)) : [...keys]
  ) as (keyof StreamTypeMap)[];
  return { gateHeartRate, providerKeys };
}

export async function getStreamSet<K extends keyof StreamTypeMap>(
  db: Db,
  userId: string,
  activityId: number,
  keys: readonly K[],
): Promise<Pick<StreamSet, K>> {
  const { gateHeartRate, providerKeys } = await resolveHeartRateGate(db, userId, keys);

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

export async function getStreamsAndLaps<K extends keyof StreamTypeMap>(
  db: Db,
  userId: string,
  activityId: number,
  keys: readonly K[],
): Promise<{ streams: Pick<StreamSet, K>; laps: Lap[] }> {
  const { gateHeartRate, providerKeys } = await resolveHeartRateGate(db, userId, keys);

  const { result, source } = await fetchIntervalsPreferred<{ streams: StreamSet; laps: Lap[] }>(
    db,
    userId,
    activityId,
    {
      fromIntervals: async (token, externalId) => {
        const [rawStreams, rawIntervals] = await Promise.all([
          intervalsApiService.getActivityStreams(token, externalId, providerKeys),
          intervalsApiService.getActivityIntervals(token, externalId),
        ]);
        return {
          streams: mapIntervalsStreamsToStreamSet(rawStreams),
          laps: mapIntervalsRawToLaps(rawIntervals),
        };
      },
      fromStrava: async (token, externalId) => {
        const [streams, laps] = await Promise.all([
          stravaApiService.getActivityStreams(token, externalId, providerKeys),
          stravaApiService.getActivityLaps(token, externalId),
        ]);
        return { streams, laps };
      },
    },
  );

  if (gateHeartRate) delete result.streams.heartrate;

  logger.info({ source, keys: providerKeys, activityId }, "streams_laps_fetch");
  return { streams: result.streams as Pick<StreamSet, K>, laps: result.laps };
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
