import "./instrumentation";
import { clerkMiddleware } from "@hono/clerk-auth";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { structuredLogger } from "@hono/structured-logger";
import { swaggerUI } from "@hono/swagger-ui";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Hono } from "hono";
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
import { seedReviewAccountData } from "./services/review_demo/seed";
import type { TGlobalEnv } from "./types/IRouters";
import { registerOAuthCallbackPages } from "./web/oauth_callback_page";
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
registerOAuthCallbackPages(app);

app.use("*", requestId());
app.use(
  "*",
  structuredLogger({
    createLogger: (c) => logger.child({ requestId: c.var.requestId }),
    onRequest: () => {},
    onResponse: (log, c, elapsedMs) => {
      const status = c.res.status;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
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
app.use("/api/*", async (c, next) => {
  c.env.db = db;
  await next();
});
app.route("/api", publicRouter);
app.use("/api/*", clientKeyGuard({ key: config.APP_CLIENT_KEY, mode: config.APP_CLIENT_KEY_MODE }));
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
v1.route("/activity", activitiesRouter);
v1.route("/activity", stravaActivitiesRouter);
v1.route("/agents", suggestSessionRouter);
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
app.route("/api", v1);
app.route("/api/v1", v1);

app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});
app.onError((err, c) => {
  const span = trace.getActiveSpan();
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

  if (err instanceof AppError) {
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

await ensureReviewAccount();
await seedReviewAccountData();

export default {
  port: config.PORT,
  fetch: app.fetch,
};
