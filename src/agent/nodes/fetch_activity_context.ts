import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { AppError } from "../../error";
import { logger } from "../../logger";
import { getIntervalsAccessToken } from "../../middlewares/intervals_middleware";
import { activities } from "../../schema";
import { getStreamsAndLaps } from "../../services/activity_source_service";
import { intervalsApiService } from "../../services/intervals_api_service";
import { stravaApiService } from "../../services/strava_api_service";
import type { Lap } from "../../types/strava/IDetailedActivity";
import type { StreamSet } from "../../types/strava/IStream";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

type ActivityMeta = {
  isIndoor: boolean;
  activityTitle: string;
  activityDescription: string;
  activityStartDateLocal: Date;
  activityType: string;
  totalElevationGain: number;
};

type ActivityContext = ActivityMeta & {
  streams: StreamSet;
  laps: Lap[];
};

export async function fetchActivityContext(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "fetchActivityContext", activityId: state.activityId });

  const [_, row] = await Promise.all([
    db
      .update(activities)
      .set({ analysisStatus: "ongoing_init", analysisStartedAt: new Date() })
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
  ]);

  const intervalsIcuId = row?.intervalsIcuId ?? null;
  const stravaActivityId = row?.stravaActivityId ?? null;

  let meta: ActivityMeta;
  if (intervalsIcuId) {
    meta = await fetchIntervalsMeta(state.userId, intervalsIcuId);
  } else if (stravaActivityId != null) {
    meta = await fetchStravaMeta(stravaAccessToken, stravaActivityId);
  } else {
    throw new AppError(400, "Activity has no intervals.icu or Strava source to fetch from");
  }

  const { streams, laps } = await getStreamsAndLaps(db, state.userId, state.activityId, [
    "time",
    "velocity_smooth",
    "heartrate",
    "distance",
    "moving",
    "latlng",
  ]);

  const context: ActivityContext = { ...meta, streams, laps };

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

async function fetchStravaMeta(
  stravaAccessToken: string,
  stravaActivityId: number,
): Promise<ActivityMeta> {
  const activity = await stravaApiService.getActivity(stravaAccessToken, stravaActivityId);
  return {
    isIndoor: activity.trainer ?? false,
    activityTitle: activity.name ?? "",
    activityDescription: activity.description ?? "",
    activityStartDateLocal: new Date(activity.start_date_local),
    activityType: activity.type,
    totalElevationGain: activity.total_elevation_gain,
  };
}

async function fetchIntervalsMeta(userId: string, intervalsIcuId: string): Promise<ActivityMeta> {
  const accessToken = await getIntervalsAccessToken(userId);
  const activity = await intervalsApiService.getActivity(accessToken, intervalsIcuId);
  return {
    isIndoor: activity.trainer ?? false,
    activityTitle: activity.name ?? "",
    activityDescription: activity.description ?? "",
    activityStartDateLocal: new Date(activity.start_date_local),
    activityType: activity.type,
    totalElevationGain: activity.total_elevation_gain ?? 0,
  };
}
