import { z } from "zod";
import * as userRepo from "../../../repositories/user_repository";
import { getOrCreateUserSettings } from "../../../repositories/user_settings_repository";
import { defineTool } from "../tool_types";

const getAthleteProfile = defineTool({
  name: "get_athlete_profile",
  description:
    "The athlete's own training-relevant profile: max heart rate (for HR zones), whether HR processing is enabled, and whether Strava / intervals.icu are connected.",
  keywords: ["profile", "max hr", "zones", "athlete", "settings", "connected", "me"],
  requires: "db",
  params: z.object({}),
  handler: async (ctx) => {
    const [user, settings] = await Promise.all([
      userRepo.findById(ctx.db, ctx.userId),
      getOrCreateUserSettings(ctx.db, ctx.userId),
    ]);
    return {
      maxHeartRate: settings.maxHeartRate,
      processHeartRate: settings.processHeartRate,
      stravaConnected: !!user?.stravaId,
      intervalsConnected: ctx.intervalsConnected,
    };
  },
});

export const profileTools = [getAthleteProfile];
