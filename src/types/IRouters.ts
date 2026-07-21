import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "../logger";
import type * as schema from "../schema";
import type { SelectUser } from "../schema";
export interface IGlobalBindings {
  db: NodePgDatabase<typeof schema>;
}

export interface IGlobalVariables {
  userId: string;
  role: "guest" | "premium" | "admin";
  user: SelectUser;
  requestId: string;
  logger: Logger;
}

export interface IStravaVariables extends IGlobalVariables {
  stravaAccessToken: string;
  stravaAthleteId: number | undefined;
}

export interface IIntervalsVariables extends IGlobalVariables {
  intervalsAccessToken: string;
}

export type TGlobalEnv = { Bindings: IGlobalBindings; Variables: IGlobalVariables };
export type TPublicEnv = {
  Bindings: IGlobalBindings;
  Variables: { requestId: string; logger: Logger };
};
export type TStravaEnv = { Bindings: IGlobalBindings; Variables: IStravaVariables };
export type TIntervalsEnv = { Bindings: IGlobalBindings; Variables: IIntervalsVariables };
