import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { AppError } from "../../error";
import { logger } from "../../logger";
import { getIntervalsAccessToken } from "../../middlewares/intervals_middleware";
import { activities } from "../../schema";
import { userHasHeartRateConsent } from "../../services/heart_rate_consent_service";
import { intervalsApiService } from "../../services/intervals_api_service";
import {
  mapIntervalsRawToLaps,
  mapIntervalsStreamsToStreamSet,
} from "../../services/intervals_mappers";
import { stravaApiService } from "../../services/strava_api_service";
import type { Lap } from "../../types/strava/IDetailedActivity";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

type ActivityContext = {
  streams: StreamSet;
  laps: Lap[];
  isIndoor: boolean;
  activityTitle: string;
  activityDescription: string;
  activityStartDateLocal: Date;
  activityType: string;
  totalElevationGain: number;
};

export async function fetchActivityContext(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken, clerkUserId } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "fetchActivityContext", activityId: state.activityId });

  const [_, row, processHeartRate] = await Promise.all([
    db
      .update(activities)
      .set({ analysisStatus: "ongoing_init" })
      .where(eq(activities.id, state.activityId)),
    db.query.activities.findFirst({
      where: eq(activities.id, state.activityId),
      columns: {
        intervalsIcuId: true,
        stravaActivityId: true,
        title: true,
        description: true,
      },
    }),
    userHasHeartRateConsent(db, state.userId),
  ]);

  const intervalsIcuId = row?.intervalsIcuId ?? null;
  const stravaActivityId = row?.stravaActivityId ?? state.stravaActivityId;

  let context: ActivityContext;
  if (intervalsIcuId) {
    context = await fetchFromIntervals(clerkUserId, intervalsIcuId, processHeartRate);
  } else if (stravaActivityId != null) {
    context = await fetchFromStrava(stravaAccessToken, stravaActivityId, processHeartRate);
  } else {
    throw new AppError(400, "Activity has no intervals.icu or Strava source to fetch from");
  }

  // The user's stored title/description (set at import, editable in-app) is the
  // authority for classification intent. The re-fetched source name can be a
  // generic auto-name — intervals.icu labels treadmill runs "Treadmill Running",
  // which hides an explicit workout title like "6x6 min" from the classifier and
  // collapses it to EASY. Prefer the DB values; fall back to the fetched ones.
  if (row?.title) context.activityTitle = row.title;
  if (row?.description) context.activityDescription = row.description;

  if (!context.streams || Object.keys(context.streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.activityId}`);
  }

  log.info(
    {
      source: intervalsIcuId ? "intervals.icu" : "strava",
      streams: Object.keys(context.streams).length,
      laps: context.laps.length,
      indoor: context.isIndoor,
    },
    "fetched activity context",
  );

  return context;
}

async function fetchFromStrava(
  stravaAccessToken: string,
  stravaActivityId: number,
  processHeartRate: boolean,
): Promise<ActivityContext> {
  const activity = await stravaApiService.getActivity(stravaAccessToken, stravaActivityId);
  const isIndoor = activity.trainer ?? false;
  const streamKeys = processHeartRate
    ? (["time", "velocity_smooth", "heartrate", "distance", "moving"] as const)
    : (["time", "velocity_smooth", "distance", "moving"] as const);

  // Indoor laps are kept: treadmill sessions often lap warmup/work/cooldown,
  // which the deterministic segmenter uses for boundaries. See
  // [[deterministic-interval-segmentation]].
  const [streams, laps] = await Promise.all([
    stravaApiService.getActivityStreams(stravaAccessToken, stravaActivityId, [...streamKeys]),
    stravaApiService.getActivityLaps(stravaAccessToken, stravaActivityId),
  ]);

  return {
    streams,
    laps,
    isIndoor,
    activityTitle: activity.name ?? "",
    activityDescription: activity.description ?? "",
    activityStartDateLocal: new Date(activity.start_date_local),
    activityType: activity.type,
    totalElevationGain: activity.total_elevation_gain,
  };
}

async function fetchFromIntervals(
  clerkUserId: string,
  intervalsIcuId: string,
  processHeartRate: boolean,
): Promise<ActivityContext> {
  const accessToken = await getIntervalsAccessToken(clerkUserId);
  const activity = await intervalsApiService.getActivity(accessToken, intervalsIcuId);
  const isIndoor = activity.trainer ?? false;

  const [rawStreams, rawIntervals] = await Promise.all([
    intervalsApiService.getActivityStreams(accessToken, intervalsIcuId),
    intervalsApiService.getActivityIntervals(accessToken, intervalsIcuId),
  ]);

  const streams = mapIntervalsStreamsToStreamSet(rawStreams);
  if (!processHeartRate) delete streams.heartrate;
  const laps = mapIntervalsRawToLaps(rawIntervals);

  return {
    streams,
    laps,
    isIndoor,
    activityTitle: activity.name ?? "",
    activityDescription: activity.description ?? "",
    activityStartDateLocal: new Date(activity.start_date_local),
    activityType: activity.type,
    totalElevationGain: activity.total_elevation_gain ?? 0,
  };
}
