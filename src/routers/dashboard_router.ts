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
  PaceAnchorResponseSchema,
  TrainingSummaryResponseSchema,
  WeekDetailResponseSchema,
  WellnessQuerySchema,
  WellnessSeriesResponseSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const dashboardRouter = new Hono<TGlobalEnv>();

dashboardRouter.get(
  "/",
  describeRoute({
    description: "Get dashboard summary, graph data, and averages",
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
  async (c) => {
    const result = await dashboardController.getDashboard(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
      new Date(),
    );
    return c.json(result);
  },
);

dashboardRouter.get(
  "/training-summary",
  describeRoute({
    description:
      "Current intervals.icu training-summary snapshot. Always returns an object discriminated by `status`: `ok` (data populated with latest wellness record — fitness model, sleep, recovery, body), `not_linked` (intervals.icu not connected), or `no_recent_data` (linked, but no wellness records in the past 7 days). All metrics in `data` are auto/device-sourced (no subjective fields).",
    responses: {
      200: {
        description: "Discriminated training-summary result",
        content: { "application/json": { schema: resolver(TrainingSummaryResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const summary = await dashboardController.getTrainingSummary(c.get("clerkUserId"));
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
  async (c) => {
    const result = await dashboardController.getPaceAnchor(
      c.env.db,
      c.get("userId"),
      c.get("clerkUserId"),
    );
    return c.json(result);
  },
);

dashboardRouter.get(
  "/wellness",
  describeRoute({
    description:
      "Daily intervals.icu wellness series for the requested date range. Discriminated by `status`: `ok` (per-day points + summary stats + metricsAvailable for the picker), `not_linked` (intervals.icu not connected), `no_data` (linked but no records in range). Each point groups fields into `fitness` (CTL/ATL/TSB/load), `sleep`, `recovery` (RHR/HRV/readiness/SpO2/respiration), `subjective` (soreness/fatigue/stress/mood/motivation, 1–4 scale), `health` (injury/sickness flags), `body` (weight/bodyFat/VO2max), and free-text `comments`. Range capped at 366 days; oldest must be ≤ newest.",
    responses: {
      200: {
        description: "Discriminated wellness-series result",
        content: { "application/json": { schema: resolver(WellnessSeriesResponseSchema) } },
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
    const result = await dashboardController.getWellnessSeries(
      c.get("clerkUserId"),
      oldest,
      newest,
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
