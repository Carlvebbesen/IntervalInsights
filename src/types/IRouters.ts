import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "../logger";
import type * as schema from "../schema";
import type { SelectUser } from "../schema";
export interface IGlobalBindings {
  db: NodePgDatabase<typeof schema>;
}

export interface IGlobalVariables {
  clerkUserId: string;
  userId: string;
  role: "guest" | "premium" | "admin";
  user: SelectUser;
  requestId: string;
  logger: Logger;
}

// Extend the global variables for Strava-specific routes
export interface IStravaVariables extends IGlobalVariables {
  stravaAccessToken: string;
  stravaAthleteId: number | undefined;
}

// Extend the global variables for Intervals.icu-specific routes
export interface IIntervalsVariables extends IGlobalVariables {
  intervalsAccessToken: string;
}

// Helper types for the Hono Generics

export type TGlobalEnv = { Bindings: IGlobalBindings; Variables: IGlobalVariables };
export type TPublicEnv = {
  Bindings: IGlobalBindings;
  Variables: { requestId: string; logger: Logger };
};
export type TStravaEnv = { Bindings: IGlobalBindings; Variables: IStravaVariables };
export type TIntervalsEnv = { Bindings: IGlobalBindings; Variables: IIntervalsVariables };
