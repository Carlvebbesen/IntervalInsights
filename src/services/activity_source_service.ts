import { and, eq } from "drizzle-orm";
import { AppError } from "../error";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { StreamSet } from "../types/strava/IStream";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import { intervalsApiService } from "./intervals_api_service";
import { mapIntervalsRawToLaps, mapIntervalsStreamsToStreamSet } from "./intervals_mappers";
import { stravaApiService } from "./strava_api_service";

type Db = IGlobalBindings["db"];

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
  const row = await db.query.activities.findFirst({
    where: and(eq(activities.id, activityId), eq(activities.userId, userId)),
    columns: { intervalsIcuId: true, stravaActivityId: true },
  });
  if (!row) throw new AppError(404, "Activity not found");

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

export async function getLaps(db: Db, userId: string, activityId: number) {
  const src = await resolveActivitySource(db, userId, activityId);
  if (src.kind === "intervals") {
    const raw = await intervalsApiService.getActivityIntervals(src.token, src.externalId);
    return mapIntervalsRawToLaps(raw);
  }
  return stravaApiService.getActivityLaps(src.token, src.externalId);
}

export async function getSplits(db: Db, userId: string, activityId: number) {
  const src = await resolveActivitySource(db, userId, activityId);
  // intervals.icu has no per-km splits_metric equivalent; the app derives splits
  // in-app from the distance stream. Strava still provides them directly.
  if (src.kind === "intervals") return [];
  const activity = await stravaApiService.getActivity(src.token, src.externalId);
  return activity.splits_metric ?? [];
}

export async function getStreamSet(db: Db, userId: string, activityId: number): Promise<StreamSet> {
  const consent = await userHasHeartRateConsent(db, userId);
  const src = await resolveActivitySource(db, userId, activityId);

  const base = ["time", "distance", "altitude", "cadence", "velocity_smooth"] as const;
  const keys = consent ? ([...base, "heartrate"] as const) : base;

  if (src.kind === "intervals") {
    return mapIntervalsStreamsToStreamSet(
      await intervalsApiService.getActivityStreams(src.token, src.externalId, [...keys]),
    );
  }
  return stravaApiService.getActivityStreams(src.token, src.externalId, [...keys]);
}

export async function getStreams(db: Db, userId: string, activityId: number) {
  const streams = await getStreamSet(db, userId, activityId);
  return {
    time: streams?.time?.data ?? [],
    distance: streams?.distance?.data ?? [],
    heartrate: streams?.heartrate?.data ?? null,
    altitude: streams?.altitude?.data ?? null,
    cadence: streams?.cadence?.data ?? null,
    velocity: streams?.velocity_smooth?.data ?? null,
  };
}
