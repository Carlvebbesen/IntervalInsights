import { z } from "zod";
import { getStreamSet } from "../../../services/activity_source_service";
import { normalizeActivityStreams, prepareDataForLLM } from "../../../services/utils";
import { defineTool } from "../tool_types";
import { resolveOwnedActivity } from "./_shared";

const getActivityStreamsSummary = defineTool({
  name: "get_activity_streams_summary",
  description:
    "Time-bucketed time-series for one activity: pace and heart rate per window, plus totals and HR variability. Use to inspect how an activity's effort/HR evolved over time.",
  keywords: [
    "streams",
    "heartrate",
    "hr",
    "pace",
    "timeseries",
    "time series",
    "effort",
    "decoupling",
    "buckets",
  ],
  requires: "activity-source",
  params: z.object({
    activityId: z.number().int(),
    bucketSeconds: z
      .number()
      .int()
      .min(10)
      .max(300)
      .optional()
      .describe("window size in seconds, defaults to 30"),
  }),
  handler: async (ctx, args) => {
    const activity = await resolveOwnedActivity(ctx, args.activityId);
    if (activity.intervalsIcuId == null && activity.stravaActivityId == null) {
      return {
        error:
          "This activity has no linked intervals.icu or Strava source, so time-series streams are unavailable.",
      };
    }
    const streams = await getStreamSet(ctx.db, ctx.userId, args.activityId, [
      "time",
      "distance",
      "velocity_smooth",
      "heartrate",
      "moving",
    ]);
    if (!streams?.time?.data?.length) {
      return { error: "No time-series stream data available for this activity." };
    }
    const normalized = normalizeActivityStreams(
      streams.time.data,
      streams.velocity_smooth?.data,
      streams.heartrate?.data,
      streams.distance?.data,
      streams.moving?.data,
    );
    return prepareDataForLLM(normalized, args.bucketSeconds ?? 30);
  },
});

export const streamTools = [getActivityStreamsSummary];
