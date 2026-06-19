// Builds a Hono app that mirrors src/index.ts but with a stub auth layer.
//
// Goal: end-to-end-style endpoint tests without Clerk JWT validation. Every
// `/api/*` request reads `userId`/`clerkUserId`/`role` from an
// AsyncLocalStorage that the test sets up via `withIdentity()` before calling
// app.fetch.
//
// The real Strava/Intervals middlewares still run — they read tokens from
// Clerk's private metadata, which the test setup mocks to always return valid
// tokens. So routes protected by those middlewares just work.

import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Pool } from "pg";
import { AppError, IntervalsError, StravaError } from "../../src/error";
import { logger } from "../../src/logger";
import activitiesRouter, {
  stravaActivitiesRouter,
} from "../../src/routers/activities_router";
import adminRouter from "../../src/routers/admin_router";
import agentsRouter from "../../src/routers/agents_router";
import dashboardRouter from "../../src/routers/dashboard_router";
import eventsRouter from "../../src/routers/events_router";
import heartRateRouter from "../../src/routers/heart_rate_router";
import intervalStructureRouter from "../../src/routers/interval_structure_router";
import intervalsEntryRouter from "../../src/routers/intervals/intervals_entry_router";
import progressRouter from "../../src/routers/progress_router";
import publicRouter from "../../src/routers/public_router";
import stravaEntryRouter from "../../src/routers/strava/strava_entry_router";
import userRouter from "../../src/routers/user_router";
import * as schema from "../../src/schema";
import type { TGlobalEnv } from "../../src/types/IRouters";

export type TestIdentity = {
  userId: string;
  clerkUserId: string;
  role: "guest" | "premium" | "admin";
};

const identityStorage = new AsyncLocalStorage<TestIdentity>();

/** Wrap test logic so any request fired inside sees this identity. */
export function withIdentity<T>(
  identity: TestIdentity,
  fn: () => Promise<T> | T,
): Promise<T> {
  return identityStorage.run(identity, async () => fn());
}

const testAuthGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const identity = identityStorage.getStore();
  if (!identity) {
    return c.json({ error: "Unauthorized (no test identity)" }, 401);
  }
  c.set("userId", identity.userId);
  c.set("clerkUserId", identity.clerkUserId);
  c.set("role", identity.role);
  const dbUser = await c.env.db.query.users.findFirst({
    where: eq(schema.users.id, identity.userId),
  });
  if (dbUser) {
    c.set("user", dbUser);
  }
  c.set("logger", logger);
  c.set("requestId", "test-req");
  await next();
});

const testLoggerMiddleware = createMiddleware(async (c, next) => {
  c.set("logger", logger);
  c.set("requestId", "test-req");
  await next();
});

export function buildTestApp(pool: Pool) {
  const db = drizzle({ client: pool, schema });
  const app = new Hono<TGlobalEnv>();

  app.use("*", testLoggerMiddleware);

  app.route("/api", publicRouter);

  app.use("/api/*", testAuthGuard);

  app.route("/api/activity", activitiesRouter);
  app.route("/api/activity", stravaActivitiesRouter);
  app.route("/api/agents", agentsRouter);
  app.route("/api/strava", stravaEntryRouter);
  app.route("/api/interval-structures", intervalStructureRouter);
  app.route("/api/dashboard", dashboardRouter);
  app.route("/api/heart-rate", heartRateRouter);
  app.route("/api/events", eventsRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/user", userRouter);
  app.route("/api/intervals", intervalsEntryRouter);
  app.route("/api/progress", progressRouter);

  app.notFound((c) => c.json({ status: 404, message: "Not Found" }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        err.details !== undefined
          ? { error: err.message, details: err.details }
          : { error: err.message },
        err.status as ContentfulStatusCode,
      );
    }
    if (err instanceof StravaError) {
      return c.json(
        { error: "Strava API Error", details: err.details },
        err.status as ContentfulStatusCode,
      );
    }
    if (err instanceof IntervalsError) {
      return c.json(
        { error: "Intervals.icu API Error", details: err.details },
        err.status as ContentfulStatusCode,
      );
    }
    c.var.logger.error({ err }, "Test app internal error");
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return {
    fetch: (request: Request) => app.fetch(request, { db }),
  };
}
