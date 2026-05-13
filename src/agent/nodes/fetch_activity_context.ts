import type { RunnableConfig } from "@langchain/core/runnables";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { activities } from "../../schema";
import { userHasHeartRateConsent } from "../../services.ts/heart_rate_consent_service";
import { stravaApiService } from "../../services.ts/strava_api_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function fetchActivityContext(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db, stravaAccessToken } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "fetchActivityContext", activityId: state.activityId });

  const [_, activity, processHeartRate] = await Promise.all([
    db
      .update(activities)
      .set({ analysisStatus: "ongoing_init" })
      .where(eq(activities.id, state.activityId)),
    stravaApiService.getActivity(stravaAccessToken, state.stravaActivityId),
    userHasHeartRateConsent(db, state.userId),
  ]);

  const isIndoor = activity.trainer ?? false;
  const streamKeys = processHeartRate
    ? (["time", "velocity_smooth", "heartrate", "distance", "moving"] as const)
    : (["time", "velocity_smooth", "distance", "moving"] as const);

  const [streams, laps] = await Promise.all([
    stravaApiService.getActivityStreams(stravaAccessToken, state.stravaActivityId, [...streamKeys]),
    isIndoor
      ? Promise.resolve([])
      : stravaApiService.getActivityLaps(stravaAccessToken, state.stravaActivityId),
  ]);

  if (!streams || Object.keys(streams).length === 0) {
    throw new Error(`No streams returned for activity ${state.stravaActivityId}`);
  }

  log.info(
    { streams: Object.keys(streams).length, laps: laps.length, indoor: isIndoor },
    "fetched activity context",
  );

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
