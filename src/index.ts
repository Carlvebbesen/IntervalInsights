// Side-effect import: must come first so the SDK initialises before any
// instrumented module is loaded. Also ensures the compiled binary embeds it.
import "./instrumentation";
import { clerkMiddleware } from "@hono/clerk-auth";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { structuredLogger } from "@hono/structured-logger";
import { swaggerUI } from "@hono/swagger-ui";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openAPIRouteHandler } from "hono-openapi";
import { auth, ensureReviewAccount } from "./auth";
import { config } from "./config";
import { db } from "./db";
import { AppError, IntervalsError, StravaError } from "./error";
import { logger } from "./logger";
import { authGuard } from "./middlewares/auth_middleware";
import { clientKeyGuard } from "./middlewares/client_key_middleware";
import activitiesRouter, { stravaActivitiesRouter } from "./routers/activities_router";
import adminRouter from "./routers/admin_router";
import agentsRouter from "./routers/agents_router";
import dashboardRouter from "./routers/dashboard_router";
import eventsRouter from "./routers/events_router";
import gearRouter, { gearStravaRouter } from "./routers/gear_router";
import heartRateRouter from "./routers/heart_rate_router";
import intervalStructureRouter from "./routers/interval_structure_router";
import intervalsEntryRouter from "./routers/intervals/intervals_entry_router";
import mcpRouter from "./routers/mcp_router";
import progressRouter from "./routers/progress_router";
import publicRouter from "./routers/public_router";
import stravaEntryRouter from "./routers/strava/strava_entry_router";
import suggestSessionRouter from "./routers/suggest_session_router";
import trainingRouter from "./routers/training_router";
import userRouter from "./routers/user_router";
import type { TGlobalEnv } from "./types/IRouters";
import { registerWebPages } from "./web/pages";

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

app.get("/app-icon-email.png", async (_c) => {
  const file = Bun.file(new URL("./app_icon_email.png", import.meta.url).pathname);
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

app.get("/.well-known/assetlinks.json", async (_c) => {
  const file = Bun.file(new URL("./.well-known/assetlinks.json", import.meta.url).pathname);
  return new Response(file, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

registerWebPages(app);

app.use("*", requestId());
app.use(
  "*",
  structuredLogger({
    createLogger: (c) => logger.child({ requestId: c.var.requestId }),
    // Suppress the default "request start" line — it doubles log volume and the
    // response line below carries everything it did.
    onRequest: () => {},
    onResponse: (log, c, elapsedMs) => {
      const status = c.res.status;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      // streamSSE resolves the handler at stream-open, so the elapsed here is the
      // open time, not the connection lifetime — label it so it isn't misread.
      const isStream = c.req.path === "/api/v1/progress/stream";
      log[level](
        {
          method: c.req.method,
          path: c.req.path,
          status,
          elapsedMs: Math.round(elapsedMs),
          userId: c.get("userId"),
        },
        isStream ? "sse stream opened" : "request",
      );
    },
  }),
);
app.use("/api/*", httpInstrumentationMiddleware({ captureRequestHeaders: ["user-agent"] }));
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-client-key"],
    exposeHeaders: ["Content-Length", "X-Request-Id"],
    maxAge: 3600,
  }),
);
app.use("/api/*", async (c, next) => {
  c.env.db = db;
  await next();
});
app.route("/api", publicRouter);
// App client key: mounted after the public routes (so webhooks/health/legal,
// registered above, terminate their chains before it) and before the Better
// Auth handler (so OTP send/verify is gated too). See client_key_middleware.ts.
app.use("/api/*", clientKeyGuard({ key: config.APP_CLIENT_KEY, mode: config.APP_CLIENT_KEY_MODE }));
// Better Auth endpoints (dual-auth window): mounted before the Clerk middleware
// chain so /api/auth/* is public — mirrors how publicRouter mounts before Clerk.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/", mcpRouter);
if (config.NODE_ENV !== "production") {
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

const v1 = new Hono<TGlobalEnv>();
// Mount-order invariant: for each shared prefix the plain router MUST mount
// before its strava-middleware twin (activity, agents, gear), or every plain
// route would silently require a Strava link. Guarded by tests/mount_order.test.ts.
v1.route("/activity", activitiesRouter);
v1.route("/activity", stravaActivitiesRouter);
v1.route("/agents", suggestSessionRouter); // order matters: before agentsRouter
v1.route("/agents", agentsRouter);
v1.route("/strava", stravaEntryRouter);
v1.route("/interval-structures", intervalStructureRouter);
v1.route("/dashboard", dashboardRouter);
v1.route("/heart-rate", heartRateRouter);
v1.route("/events", eventsRouter);
v1.route("/gear", gearRouter);
v1.route("/gear", gearStravaRouter);
v1.route("/admin", adminRouter);
v1.route("/user", userRouter);
v1.route("/intervals", intervalsEntryRouter);
v1.route("/chat", trainingRouter);
v1.route("/progress", progressRouter);
// Transitional dual-mount: also serve the authed routers at the legacy unversioned
// /api/* so already-installed app builds (which pin BACKEND_URL=…/api/ at compile
// time) keep working during the /api/v1 rollout. Registered AFTER publicRouter so the
// public webhook/health/legal paths still win their exact routes. Remove this line once
// legacy /api/* traffic drains — see docs/backend-followups-plan.md, Phase 0.
app.route("/api", v1);
app.route("/api/v1", v1);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
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
  if ("clerkError" in err && err.clerkError === true) {
    c.var.logger.error({ err }, "Clerk API error");
    const status = "status" in err && err.status === 429 ? 429 : 502;
    return c.json({ error: "Authentication service error" }, status);
  }
  c.var.logger.error({ err }, "Internal Error");
  return c.json({ error: "Internal Server Error" }, 500);
});

// Bun awaits module top-level before serving — seed the store-review demo
// account (no-op when REVIEW_ACCOUNT_* is unset) now that OTP auto-register is
// gone. There is no shared boot path, so this is the sole prod call site.
await ensureReviewAccount();

export default {
  port: config.PORT,
  fetch: app.fetch,
};
