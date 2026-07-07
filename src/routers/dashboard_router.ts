import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as dashboardController from "../controllers/dashboard_controller";
import {
  DashboardResponseSchema,
  ErrorSchema,
  FitnessDayParamSchema,
  FitnessDayResponseSchema,
  FitnessSeriesResponseSchema,
  PaceAnchorQuerySchema,
  PaceAnchorResponseSchema,
  TrainingSummaryQuerySchema,
  TrainingSummaryResponseSchema,
  WeekDetailResponseSchema,
  WellnessQuerySchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const dashboardRouter = new Hono<TGlobalEnv>();

dashboardRouter.get(
  "/",
  describeRoute({
    description:
      "Get dashboard summary, graph data, and averages. Pass `date` (YYYY-MM-DD, the athlete's local calendar date) so week boundaries are resolved against the athlete's day — activities store local-as-UTC timestamps, so the server's UTC clock puts near-midnight activities in the wrong week for far-from-UTC users. Falls back to the server date when omitted.",
    responses: {
      200: {
        description: "Dashboard data",
        content: { "application/json": { schema: resolver(DashboardResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", TrainingSummaryQuerySchema),
  async (c) => {
    const { date } = c.req.valid("query");
    // Anchor at end-of-day of the athlete's local date: startDateLocal is
    // stored local-as-UTC, so all week math must run on the athlete's calendar.
    const now = date ? new Date(`${date}T23:59:59.999Z`) : new Date();
    const result = await dashboardController.getDashboard(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      now,
    );
    return c.json(result);
  },
);

dashboardRouter.get(
  "/training-summary",
  describeRoute({
    description:
      "Current intervals.icu training-summary snapshot. Always returns an object discriminated by `status`: `ok` (data populated with latest wellness record — fitness model, sleep, recovery, body), `not_linked` (intervals.icu not connected), or `no_recent_data` (linked, but no wellness records in the past 7 days). All metrics in `data` are auto/device-sourced (no subjective fields). Pass `date` (YYYY-MM-DD, the athlete's local calendar date) so `trainedToday`/`todaySessions` are resolved against the athlete's day rather than the server's UTC day.",
    responses: {
      200: {
        description: "Discriminated training-summary result",
        content: { "application/json": { schema: resolver(TrainingSummaryResponseSchema) } },
      },
    },
  }),
  validator("query", TrainingSummaryQuerySchema),
  async (c) => {
    const { date } = c.req.valid("query");
    const summary = await dashboardController.getTrainingSummary(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      date,
    );
    return c.json(summary);
  },
);

dashboardRouter.get(
  "/pace-anchor",
  describeRoute({
    description:
      "Derives the athlete's current fitness 'anchor' from their recent (~90-day) best-effort running curve and returns predicted training paces in sec/km. Discriminated by `status`: `ok` (data populated; intervals.icu linked — but `anchorSource` may still be `none` when there is no genuine maximal effort to anchor on) or `not_linked` (intervals.icu not connected). `anchorSource` is `critical_speed` (slope of the distance–time fit over 2–15 min maximal efforts), `vdot` (Daniels, from a single representative effort), or `none`. When `none`, paces are null and `predictedRaces` is empty — never fabricated. `confidence` (high/medium/low) reflects the fit quality / available points.",
    responses: {
      200: {
        description: "Discriminated pace-anchor result",
        content: { "application/json": { schema: resolver(PaceAnchorResponseSchema) } },
      },
    },
  }),
  validator("query", PaceAnchorQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const weather =
      q.temperatureC != null && q.humidity != null
        ? {
            temperatureC: q.temperatureC,
            humidity: q.humidity,
            uvIndex: q.uvIndex,
            cloudCover: q.cloudCover,
            apparentTemperatureC: q.apparentTemperatureC,
          }
        : undefined;
    const result = await dashboardController.getPaceAnchor(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      weather,
    );
    return c.json(result);
  },
);

dashboardRouter.get(
  "/fitness",
  describeRoute({
    description:
      "Flat fitness-view series for the requested date range. Discriminated by `status`: `ok` (per-day points: CTL/ATL/TSB/CTL-load/ATL-load + HRV with derived `hrvStatus` + sleep score), `not_linked` (intervals.icu not connected), `no_data` (linked but no records in range). `hrvStatus` is computed (7-day rolling HRV mean vs ~60-day baseline ± 1 SD) and is null when history is insufficient. Range capped at 366 days; oldest must be ≤ newest.",
    responses: {
      200: {
        description: "Discriminated fitness-series result",
        content: { "application/json": { schema: resolver(FitnessSeriesResponseSchema) } },
      },
      400: {
        description: "Invalid date range",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", WellnessQuerySchema),
  async (c) => {
    const { oldest, newest } = c.req.valid("query");
    const result = await dashboardController.getFitnessSeries(c.get("clerkUserId"), oldest, newest);
    return c.json(result);
  },
);

dashboardRouter.get(
  "/fitness/day/:date",
  describeRoute({
    description:
      "Per-day fitness detail. Bare object (NOT status-wrapped): `date`, `fitness` (same shape as a series point, or null when intervals.icu isn't linked / has no record that day), and `activities` (this user's activities on that local date).",
    responses: {
      200: {
        description: "Day fitness detail",
        content: { "application/json": { schema: resolver(FitnessDayResponseSchema) } },
      },
      400: {
        description: "Invalid date",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", FitnessDayParamSchema),
  async (c) => {
    const { date } = c.req.valid("param");
    const result = await dashboardController.getFitnessDay(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      date,
    );
    return c.json(result);
  },
);

const weekStartParamSchema = z.object({ weekStart: z.string() });

dashboardRouter.get(
  "/week/:weekStart",
  describeRoute({
    description: "Get detailed stats for a specific week",
    responses: {
      200: {
        description: "Week detail",
        content: { "application/json": { schema: resolver(WeekDetailResponseSchema) } },
      },
      400: {
        description: "Invalid weekStart",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", weekStartParamSchema),
  async (c) => {
    const { weekStart } = c.req.valid("param");
    const result = await dashboardController.getWeekDetail(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      weekStart,
    );
    return c.json(result);
  },
);

export default dashboardRouter;
