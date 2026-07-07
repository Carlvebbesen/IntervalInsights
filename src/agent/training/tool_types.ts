import type { z } from "zod";
import type { Logger } from "../../logger";
import type { GraphDb } from "../graph_state";

export interface CoachCtx {
  db: GraphDb;
  userId: string;
  clerkUserId: string;
  stravaAccessToken: string;
  intervalsConnected: boolean;
  userTime: string;
  weather?: unknown;
  logger: Logger;
}

export type ToolRequirement = "db" | "strava" | "intervals";

export interface CoachTool {
  name: string;
  description: string;
  keywords: string[];
  requires: ToolRequirement;
  /**
   * The tool makes its own server-side OpenAI call. Declared at the definition
   * site so MCP exposure (which must exclude these — external clients must not
   * drive our model spend) can't silently drift when tools are added/renamed.
   */
  llmBacked?: boolean;
  params: z.ZodObject<z.ZodRawShape>;
  handler: (ctx: CoachCtx, args: Record<string, unknown>) => Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(spec: {
  name: string;
  description: string;
  keywords: string[];
  requires: ToolRequirement;
  llmBacked?: boolean;
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
  return tool.requires === "intervals" ? ctx.intervalsConnected : true;
}
