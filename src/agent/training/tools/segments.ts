import { z } from "zod";
import { getSegmentsForActivity } from "../../../services/lap_derivation_service";
import { stravaApiService } from "../../../services/strava_api_service";
import { defineTool } from "../tool_types";
import { resolveOwnedActivity } from "./_shared";

const getActivitySegments = defineTool({
  name: "get_activity_segments",
  description:
    "Per-segment breakdown of an interval workout (warmup, work intervals, rests, cooldown) with actual distance, duration, avg HR and target pace. Stored or re-derived from laps.",
  keywords: ["segments", "intervals", "splits", "reps", "breakdown", "sets", "structure"],
  requires: "strava",
  params: z.object({ activityId: z.number().int() }),
  handler: async (ctx, args) => {
    await resolveOwnedActivity(ctx, args.activityId);
    return getSegmentsForActivity(ctx.db, ctx.clerkUserId, args.activityId);
  },
});

const getActivityLaps = defineTool({
  name: "get_activity_laps",
  description:
    "Raw Strava laps for an activity: per-lap distance, moving/elapsed time, average speed, and HR. Use when you need lap-level detail beyond the derived segments.",
  keywords: ["laps", "splits", "strava", "lap", "pace", "speed"],
  requires: "strava",
  params: z.object({ activityId: z.number().int() }),
  handler: async (ctx, args) => {
    const activity = await resolveOwnedActivity(ctx, args.activityId);
    if (activity.stravaActivityId == null) {
      return { error: "This activity has no Strava id, so Strava laps are unavailable." };
    }
    return stravaApiService.getActivityLaps(ctx.stravaAccessToken, activity.stravaActivityId);
  },
});

export const segmentTools = [getActivitySegments, getActivityLaps];
