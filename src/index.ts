// Side-effect import: must come first so the SDK initialises before any
// instrumented module is loaded. Also ensures the compiled binary embeds it.
import "./instrumentation";
import { clerkMiddleware } from "@hono/clerk-auth";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { structuredLogger } from "@hono/structured-logger";
import { swaggerUI } from "@hono/swagger-ui";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openAPIRouteHandler } from "hono-openapi";
import { Pool } from "pg";
import { config } from "./config";
import { AppError, IntervalsError, StravaError } from "./error";
import { logger } from "./logger";
import { authGuard } from "./middlewares/auth_middleware";
import activitiesRouter, { stravaActivitiesRouter } from "./routers/activities_router";
import adminRouter from "./routers/admin_router";
import agentsRouter from "./routers/agents_router";
import dashboardRouter from "./routers/dashboard_router";
import eventsRouter from "./routers/events_router";
import intervalStructureRouter from "./routers/interval_structure_router";
import intervalsEntryRouter from "./routers/intervals/intervals_entry_router";
import publicRouter from "./routers/public_router";
import stravaEntryRouter from "./routers/strava/strava_entry_router";
import userRouter from "./routers/user_router";
import * as schema from "./schema";
import type { TGlobalEnv } from "./types/IRouters";

const pool = new Pool({ connectionString: config.DATABASE_URL });
const db = drizzle({ client: pool, schema });

const app = new Hono<TGlobalEnv>();

app.get("/", async (c) => {
  const html = await Bun.file(new URL("./landing.html", import.meta.url).pathname).text();
  return c.html(html);
});

app.get("/app-icon.png", async (_c) => {
  const file = Bun.file(new URL("./app_icon.png", import.meta.url).pathname);
  return new Response(file, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
});

app.get("/favicon.ico", async (_c) => {
  const file = Bun.file(new URL("./app_icon.png", import.meta.url).pathname);
  return new Response(file, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
});

app.get("/.well-known/apple-app-site-association", async (_c) => {
  const file = Bun.file(
    new URL("./.well-known/apple-app-site-association.json", import.meta.url).pathname,
  );
  return new Response(file, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

app.use("*", requestId());
app.use(
  "*",
  structuredLogger({
    createLogger: (c) => logger.child({ requestId: c.var.requestId }),
  }),
);
app.use("/api/*", httpInstrumentationMiddleware({ captureRequestHeaders: ["user-agent"] }));
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Request-Id"],
    maxAge: 3600,
    credentials: true,
  }),
);
app.use("/api/*", async (c, next) => {
  c.env.db = db;
  await next();
});
app.route("/api", publicRouter);
if (process.env.NODE_ENV !== "production") {
  app.get(
    "/api/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: { title: "Interval Insights API", version: "1.0.0" },
        servers: [{ url: "http://localhost:3000" }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  );
  app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));
}

app.use("/api/*", clerkMiddleware());
app.use("/api/*", authGuard);

app.route("/api/activity", activitiesRouter);
app.route("/api/activity", stravaActivitiesRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/strava", stravaEntryRouter);
app.route("/api/interval-structures", intervalStructureRouter);
app.route("/api/dashboard", dashboardRouter);
app.route("/api/events", eventsRouter);
app.route("/api/admin", adminRouter);
app.route("/api/user", userRouter);
app.route("/api/intervals", intervalsEntryRouter);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      status: 404,
      message: "Not Found",
    },
    404,
  );
});
app.onError((err, c) => {
  const span = trace.getActiveSpan();
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

  if (err instanceof AppError) {
    // Expected client errors (4xx) are warn-level noise; only 5xx are true errors.
    if (err.status >= 500) c.var.logger.error({ err }, err.message);
    else c.var.logger.warn({ err }, err.message);
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
  c.var.logger.error({ err }, "Internal Error");
  return c.json({ error: "Internal Server Error" }, 500);
});

export default {
  port: config.PORT,
  fetch: app.fetch,
};
