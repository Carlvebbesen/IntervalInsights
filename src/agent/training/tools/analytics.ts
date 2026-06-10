import { z } from "zod";
import * as dashboardRepo from "../../../repositories/dashboard_repository";
import { RUNNING_SPORT_TYPES } from "../../../schema/enums";
import { defineTool } from "../tool_types";
import { ctxToday, isoDaysAgo } from "./_shared";

const trainingLoadByWeek = defineTool({
  name: "training_load_by_week",
  description:
    "Weekly training-load rollup (default last 84 days): per week the session count, total training load, total distance and moving time. Use for load-ramp / build-vs-recovery analysis and to chart load over time. Defaults to running sports; pass sportTypes to widen.",
  keywords: ["load", "training load", "tss", "ramp", "weekly", "build", "volume", "trend", "acwr"],
  requires: "db",
  params: z.object({
    sinceDate: z.string().optional().describe("ISO date; default 84 days ago"),
    sportTypes: z
      .array(z.string())
      .optional()
      .describe("defaults to running sports; pass e.g. ['Run','Ride'] to include others"),
  }),
  handler: (ctx, args) =>
    dashboardRepo.trainingLoadByWeek(
      ctx.db,
      ctx.userId,
      args.sportTypes ?? [...RUNNING_SPORT_TYPES],
      new Date(args.sinceDate ?? isoDaysAgo(ctx, 84)),
    ),
});

const trainingTypeDistribution = defineTool({
  name: "training_type_distribution",
  description:
    "Breakdown of training by training type over a window (default last 90 days): sessions, total load, distance and moving time per type (EASY/LONG/THRESHOLD/INTERVALS/etc.). Use for polarization / easy-hard balance and intensity-distribution questions. Covers all sports.",
  keywords: [
    "distribution",
    "polarization",
    "polarized",
    "balance",
    "intensity",
    "easy hard",
    "breakdown",
    "training type",
    "mix",
  ],
  requires: "db",
  params: z.object({
    from: z.string().optional().describe("ISO date; default 90 days ago"),
    to: z.string().optional().describe("ISO date; default today"),
  }),
  handler: (ctx, args) =>
    dashboardRepo.trainingTypeDistribution(
      ctx.db,
      ctx.userId,
      new Date(args.from ?? isoDaysAgo(ctx, 90)),
      new Date(args.to ?? ctxToday(ctx)),
    ),
});

export const analyticsTools = [trainingLoadByWeek, trainingTypeDistribution];
