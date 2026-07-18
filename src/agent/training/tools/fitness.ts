import { z } from "zod";
import { FITNESS_SPORT_VALUES } from "../../../schemas/dashboard_schemas";
import { fetchFitnessDayBlock, fetchFitnessSeries } from "../../../services/fitness_service";
import {
  fetchTrainingSummary,
  fetchWeekWellnessStats,
  fetchWellnessSeries,
  fetchWellnessSummary,
} from "../../../services/intervals_wellness_service";
import { defineTool } from "../tool_types";
import { ctxToday, isoDaysAgo } from "./_shared";

const getFitnessToday = defineTool({
  name: "get_fitness_today",
  description:
    "Latest fitness/recovery snapshot from intervals.icu: CTL (fitness), ATL (fatigue), ramp rate, sleep score/secs, resting HR, HRV, readiness, SpO2, weight, VO2max.",
  keywords: [
    "ctl",
    "atl",
    "tsb",
    "form",
    "fitness",
    "fatigue",
    "readiness",
    "today",
    "snapshot",
    "hrv",
    "sleep",
  ],
  requires: "activity-source",
  params: z.object({}),
  handler: (ctx) => fetchTrainingSummary(ctx.db, ctx.userId, ctxToday(ctx)),
});

const getFitnessDay = defineTool({
  name: "get_fitness_day",
  description:
    "Fitness block for a single day: CTL, ATL, TSB (form), HRV (+ Garmin-style balanced/unbalanced status), and sleep score.",
  keywords: ["ctl", "atl", "tsb", "form", "hrv", "sleep", "day", "date"],
  requires: "activity-source",
  params: z.object({ date: z.string().optional().describe("ISO date; defaults to today") }),
  handler: (ctx, args) => fetchFitnessDayBlock(ctx.db, ctx.userId, args.date ?? ctxToday(ctx)),
});

const getFitnessSeries = defineTool({
  name: "get_fitness_series",
  description:
    "Daily CTL/ATL/TSB (form) + HRV (with status) + sleep score over a date range (default last 42 days). Use for fitness/form trends and taper/peaking questions.",
  keywords: [
    "ctl",
    "atl",
    "tsb",
    "form",
    "trend",
    "series",
    "fitness",
    "fatigue",
    "hrv",
    "sleep",
    "taper",
  ],
  requires: "activity-source",
  params: z.object({
    oldest: z.string().optional().describe("ISO date; default 42 days ago"),
    newest: z.string().optional().describe("ISO date; default today"),
    sport: z
      .enum(FITNESS_SPORT_VALUES)
      .optional()
      .describe(
        "Per-sport series ('running' or an exact sport type). Omit for the combined series.",
      ),
  }),
  handler: (ctx, args) =>
    fetchFitnessSeries(
      ctx.db,
      ctx.userId,
      args.oldest ?? isoDaysAgo(ctx, 42),
      args.newest ?? ctxToday(ctx),
      args.sport,
    ),
});

const getWellnessSummary = defineTool({
  name: "get_wellness_summary",
  description:
    "Aggregated wellness over a range (default last 7 days): CTL, ATL, TSB, average HRV, average sleep quality, resting HR.",
  keywords: ["wellness", "summary", "hrv", "sleep", "resting hr", "recovery", "week"],
  requires: "intervals",
  params: z.object({
    oldest: z.string().optional().describe("ISO date; default 7 days ago"),
    newest: z.string().optional().describe("ISO date; default today"),
  }),
  handler: (ctx, args) =>
    fetchWellnessSummary(
      ctx.db,
      ctx.userId,
      args.oldest ?? isoDaysAgo(ctx, 7),
      args.newest ?? ctxToday(ctx),
    ),
});

const getWeekWellness = defineTool({
  name: "get_week_wellness",
  description:
    "Week wellness rollup (default last 7 days): avg sleep score, avg fatigue, current fitness & form, total load.",
  keywords: ["week", "wellness", "sleep", "fatigue", "fitness", "form", "load"],
  requires: "intervals",
  params: z.object({
    oldest: z.string().optional().describe("ISO date; default 7 days ago"),
    newest: z.string().optional().describe("ISO date; default today"),
  }),
  handler: (ctx, args) =>
    fetchWeekWellnessStats(
      ctx.db,
      ctx.userId,
      args.oldest ?? isoDaysAgo(ctx, 7),
      args.newest ?? ctxToday(ctx),
    ),
});

const getWellnessSeries = defineTool({
  name: "get_wellness_series",
  description:
    "Full daily wellness series over a range (default 30 days): every metric intervals.icu tracks — fitness, sleep, recovery (HRV/resting HR/readiness/SpO2/respiration), subjective (soreness/fatigue/stress/mood/motivation), health, body — with per-metric min/max/avg/latest.",
  keywords: [
    "wellness",
    "series",
    "metrics",
    "soreness",
    "fatigue",
    "stress",
    "mood",
    "weight",
    "vo2max",
    "respiration",
    "spo2",
    "readiness",
  ],
  requires: "intervals",
  params: z.object({
    oldest: z.string().optional().describe("ISO date; default 30 days ago"),
    newest: z.string().optional().describe("ISO date; default today"),
  }),
  handler: (ctx, args) =>
    fetchWellnessSeries(
      ctx.db,
      ctx.userId,
      args.oldest ?? isoDaysAgo(ctx, 30),
      args.newest ?? ctxToday(ctx),
    ),
});

export const fitnessTools = [
  getFitnessToday,
  getFitnessDay,
  getFitnessSeries,
  getWellnessSummary,
  getWeekWellness,
  getWellnessSeries,
];
