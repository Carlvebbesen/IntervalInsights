import type { z } from "zod";
import type { Logger } from "../../logger";
import type { GraphDb } from "../graph_state";

export interface CoachCtx {
  db: GraphDb;
  userId: string;
  stravaAccessToken: string;
  intervalsConnected: boolean;
  stravaLinked: boolean;
  userTime: string;
  weather?: unknown;
  logger: Logger;
}

export type ToolRequirement = "db" | "strava" | "intervals" | "activity-source";

export interface CoachTool {
  name: string;
  description: string;
  keywords: string[];
  requires: ToolRequirement;
  llmBacked?: boolean;
  /**
   * Tool belongs to a premium-only feature. The coach-chat surface is already
   * behind `requireRole("premium","admin")` at its router, so this only bites
   * on MCP, which authenticates with its own OAuth token and would otherwise
   * hand a free user the same controllers the gated REST routes protect.
   */
  premium?: boolean;
  params: z.ZodObject<z.ZodRawShape>;
  handler: (ctx: CoachCtx, args: Record<string, unknown>) => Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(spec: {
  name: string;
  description: string;
  keywords: string[];
  requires: ToolRequirement;
  llmBacked?: boolean;
  premium?: boolean;
  params: z.ZodObject<S>;
  handler: (ctx: CoachCtx, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}): CoachTool {
  return {
    ...spec,
    params: spec.params.strict() as unknown as z.ZodObject<z.ZodRawShape>,
    handler: spec.handler as CoachTool["handler"],
  };
}

export function isToolAvailable(tool: CoachTool, ctx: CoachCtx): boolean {
  if (tool.requires === "intervals") return ctx.intervalsConnected;
  if (tool.requires === "activity-source") return ctx.intervalsConnected || ctx.stravaLinked;
  // Strava tools call the provider directly, so gate on an actual token rather
  // than the `stravaId` sentinel — the demo user is "linked" but has no token.
  if (tool.requires === "strava") return !!ctx.stravaAccessToken;
  return true;
}
