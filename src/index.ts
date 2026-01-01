import { clerkMiddleware, } from "@hono/clerk-auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import stravaEntryRouter from "./routers/strava/strava_entry_router";
import { authGuard } from "./middlewares/auth_middleware";
import {  TGlobalEnv } from "./types/IRouters";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { logger } from 'hono/logger'
import publicRouter from "./routers/public_router";
import { StravaError } from "./error";
import activitiesRouter from "./routers/activities_router";
import agentsRouter from "./routers/agents_router";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });


const app = new Hono<TGlobalEnv>()

app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 3600,
  credentials: true
}))
app.use('/api/*', async (c, next) => {
  c.env.db = db;
  await next();
});
app.route("/api", publicRouter);
app.use('/api/*', clerkMiddleware())
app.use('/api/*', authGuard);

app.route("/api/activity", activitiesRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/strava", stravaEntryRouter);

// 404 handler
app.notFound((c) => {
  return c.json({
    status: 404,
    message: 'Not Found'
  }, 404)
})
app.onError((err, c) => {
  if (err instanceof StravaError) {
    return c.json({ error: "Strava API Error", details: err.details }, err.status as any);
  }
  console.error("Internal Error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch
}