import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { AppError } from "../../error";
import { logger } from "../../logger";
import { getIntervalsAccessToken } from "../../middlewares/intervals_middleware";
import { activities } from "../../schema";
import { getLaps, getStreamSet } from "../../services/activity_source_service";
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

  // latlng is fetched for venue detection (confirms a distance→venue snap in
  // the signature). Outdoor only in practice — indoor activities have no GPS.
  // heartrate is consent-gated inside getStreamSet. Indoor laps are kept:
  // treadmill sessions often lap warmup/work/cooldown, which the deterministic
  // segmenter uses for boundaries. See [[deterministic-interval-segmentation]].
  const [streams, laps] = await Promise.all([
    getStreamSet(db, state.userId, state.activityId, [
      "time",
      "velocity_smooth",
      "heartrate",
      "distance",
      "moving",
      "latlng",
    ]),
    getLaps(db, state.userId, state.activityId),
  ]);

  const context: ActivityContext = { ...meta, streams, laps };

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
