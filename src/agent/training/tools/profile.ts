import { z } from "zod";
import * as userRepo from "../../../repositories/user_repository";
import { defineTool } from "../tool_types";

const getAthleteProfile = defineTool({
  name: "get_athlete_profile",
  description:
    "The athlete's own training-relevant profile: max heart rate (for HR zones), whether HR processing is enabled, and whether Strava / intervals.icu are connected.",
  keywords: ["profile", "max hr", "zones", "athlete", "settings", "connected", "me"],
  requires: "db",
  params: z.object({}),
  handler: async (ctx) => {
    const user = await userRepo.findById(ctx.db, ctx.userId);
    return {
      maxHeartRate: user?.maxHeartRate ?? null,
      processHeartRate: user?.processHeartRate ?? false,
      stravaConnected: !!user?.stravaId,
      intervalsConnected: ctx.intervalsConnected,
    };
  },
});

export const profileTools = [getAthleteProfile];
