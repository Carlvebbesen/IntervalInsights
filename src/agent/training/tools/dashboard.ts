import { z } from "zod";
import * as dashboardRepo from "../../../repositories/dashboard_repository";
import { OTHER_SPORT_TYPES, RUNNING_SPORT_TYPES } from "../../../schema/enums";
import { defineTool } from "../tool_types";
import { ctxToday, isoDaysAgo } from "./_shared";

const RUNNING = [...RUNNING_SPORT_TYPES];
const ALL_SPORTS = [...RUNNING_SPORT_TYPES, ...OTHER_SPORT_TYPES];

const activitiesOnDate = defineTool({
  name: "activities_on_date",
  description:
    "All of the user's activities on a given calendar date (id, title, sport, training type, distance, time, avg HR, load).",
  keywords: ["date", "day", "today", "yesterday", "on", "calendar"],
  requires: "db",
  params: z.object({ date: z.string().optional().describe("ISO date; defaults to today") }),
  handler: (ctx, args) =>
    dashboardRepo.activitiesOnDate(ctx.db, ctx.userId, args.date ?? ctxToday(ctx)),
});

const weeklyRunDistance = defineTool({
  name: "weekly_run_distance",
  description:
    "Total running distance grouped by week, since a date (default last 84 days). Use for volume trends / training-load ramp.",
  keywords: ["weekly", "volume", "mileage", "distance", "trend", "ramp", "per week"],
  requires: "db",
  params: z.object({ sinceDate: z.string().optional().describe("ISO date; default 84 days ago") }),
  handler: (ctx, args) =>
    dashboardRepo.weeklyRunDistanceSince(
      ctx.db,
      ctx.userId,
      RUNNING,
      new Date(args.sinceDate ?? isoDaysAgo(ctx, 84)),
    ),
});

const longTermRunStats = defineTool({
  name: "long_term_run_stats",
  description:
    "Aggregate running stats since a date (default 90 days): total sessions, interval sessions, avg distance and elevation per run.",
  keywords: ["stats", "summary", "totals", "average", "long term", "aggregate"],
  requires: "db",
  params: z.object({ sinceDate: z.string().optional().describe("ISO date; default 90 days ago") }),
  handler: (ctx, args) =>
    dashboardRepo.longTermRunStatsSince(
      ctx.db,
      ctx.userId,
      RUNNING,
      new Date(args.sinceDate ?? isoDaysAgo(ctx, 90)),
    ),
});

const runsBetween = defineTool({
  name: "runs_between",
  description:
    "Every run (date + distance) between two dates. Use for custom-window volume questions.",
  keywords: ["between", "range", "runs", "distance", "window", "period"],
  requires: "db",
  params: z.object({ from: z.string().describe("ISO date"), to: z.string().describe("ISO date") }),
  handler: (ctx, args) =>
    dashboardRepo.runsBetween(
      ctx.db,
      ctx.userId,
      ALL_SPORTS,
      new Date(args.from),
      new Date(args.to),
    ),
});

export const dashboardTools = [activitiesOnDate, weeklyRunDistance, longTermRunStats, runsBetween];
