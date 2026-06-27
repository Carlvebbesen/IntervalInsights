import { z } from "zod";
import * as gearController from "../../../controllers/gear_controller";
import * as activityRepo from "../../../repositories/activity_repository";
import { eventTypeEnum, trainingTypeEnum } from "../../../schema/enums";
import { defineTool } from "../tool_types";
import { resolveOwnedActivity } from "./_shared";

const listActivities = defineTool({
  name: "list_activities",
  description:
    "List the user's analysed activities (15 per page). Filter by training type, sport, free-text search, min/max distance, date range, or linked health events. Sort by date (default), distance, or training load — use sortBy='distance' for longest runs or sortBy='load' for hardest sessions.",
  keywords: [
    "activities",
    "runs",
    "workouts",
    "history",
    "list",
    "recent",
    "sessions",
    "longest",
    "hardest",
    "sort",
  ],
  requires: "db",
  params: z.object({
    trainingType: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
    sportTypes: z.array(z.string()).optional().describe("e.g. ['Run','TrailRun','Ride']"),
    search: z.string().optional().describe("matches title/description"),
    minDistanceMeters: z.number().optional(),
    maxDistanceMeters: z.number().optional(),
    sortBy: z
      .enum(["date", "distance", "load"])
      .optional()
      .describe("defaults to 'date'. 'load' = training load."),
    order: z.enum(["asc", "desc"]).optional().describe("defaults to 'desc' (largest/newest first)"),
    dateFrom: z.string().optional().describe("ISO date, inclusive"),
    dateTo: z.string().optional().describe("ISO date, inclusive"),
    eventTypes: z.array(z.enum(eventTypeEnum.enumValues)).optional(),
    page: z.number().int().min(1).optional().describe("defaults to 1"),
  }),
  handler: (ctx, args) =>
    activityRepo.listForUser(ctx.db, ctx.userId, {
      page: args.page ?? 1,
      trainingType: args.trainingType,
      sportTypes: args.sportTypes,
      search: args.search,
      distance: args.minDistanceMeters,
      maxDistance: args.maxDistanceMeters,
      sortBy: args.sortBy,
      order: args.order,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      eventTypes: args.eventTypes,
    }),
});

const getActivity = defineTool({
  name: "get_activity",
  description:
    "Full detail for one activity: distance, time, elevation, pace, HR, power, training load, training type, feeling, notes, and intervals.icu-derived load.",
  keywords: ["activity", "detail", "single", "workout", "stats", "load", "heartrate", "power"],
  requires: "db",
  params: z.object({ activityId: z.number().int() }),
  handler: async (ctx, args) => {
    const { userId: _omit, ...rest } = await resolveOwnedActivity(ctx, args.activityId);
    return rest;
  },
});

const getGearUsage = defineTool({
  name: "get_gear_usage",
  description:
    "The user's shoes with total distance (km), activity count, and per-training-type usage counts. Useful for mileage-per-shoe questions.",
  keywords: ["gear", "shoes", "equipment", "mileage", "usage", "distance"],
  requires: "db",
  params: z.object({
    includeRetired: z.boolean().optional().describe("include retired shoes (default false)"),
  }),
  handler: async (ctx, args) =>
    (
      await gearController.listGears(ctx.db, ctx.userId, {
        includeRetired: args.includeRetired ?? false,
      })
    ).data,
});

export const activityTools = [listActivities, getActivity, getGearUsage];
