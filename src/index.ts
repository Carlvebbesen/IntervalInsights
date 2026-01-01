import { clerkMiddleware, } from "@hono/clerk-auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import stravaEntryRouter from "./routers/strava/strava_entry_router";
import { authGuard } from "./middlewares/auth_middleware";
import {  TGlobalEnv } from "./types/IRouters";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import publicRouter from "./routers/public_router";
import { StravaError } from "./error";
import { debugLogger } from "./middlewares/logger_middleware";
import activitiesRouter from "./routers/activities_router";
import agentsRouter from "./routers/agents_router";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });


const app = new Hono<TGlobalEnv>()

app.use('*', debugLogger());
app.onError((err, c) => {
  if (err instanceof StravaError) {
    return c.json({ error: "Strava API Error", details: err.details }, err.status as any);
  }
  console.error("Internal Error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});
app.use('/api/*', cors());
app.use('/api/*', async (c, next) => {
  console.log("Addind db")
  c.env.db = db;
  await next();
});
app.route("/api", publicRouter);
app.use('/api/*', clerkMiddleware())
app.use('/api/*', authGuard);

app.route("/api/activity", activitiesRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/strava", stravaEntryRouter);

export default app