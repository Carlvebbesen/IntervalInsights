import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
export interface IGlobalBindings {
  db: NodePgDatabase<typeof schema>;
}

export interface IGlobalVariables {
  clerkUserId: string;
  userId: string;
}

// Extend the global variables for Strava-specific routes
export interface IStravaVariables extends IGlobalVariables {
  stravaAccessToken: string;
  stravaAthleteId: number | undefined;
}

// Helper types for the Hono Generics

export type TGlobalEnv = { Bindings: IGlobalBindings; Variables: IGlobalVariables };
export type TPublicEnv = { Bindings: IGlobalBindings; Variables:{} };
export type TStravaEnv = { Bindings: IGlobalBindings; Variables: IStravaVariables };