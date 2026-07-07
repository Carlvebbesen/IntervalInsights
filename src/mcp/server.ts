import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { registry, runTool } from "../agent/training/tool_registry";
import type { CoachCtx, CoachTool } from "../agent/training/tool_types";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import type { TMcpEnv } from "./types";

const MCP_SERVER_NAME = "interval-insights";
const MCP_SERVER_VERSION = "0.1.0";

export interface McpAvailability {
  stravaLinked: boolean;
  intervalsConnected: boolean;
}

/**
 * The coach registry, gated to what this athlete can actually serve. Every coach
 * tool is read-only, so the registry is safe to expose over MCP — we only drop
 * tools whose backing integration isn't connected, plus any `llmBacked` tool
 * (declared at the definition site): an external client (Claude/ChatGPT) must
 * not drive our OpenAI spend through us — it has its own LLM.
 */
export function selectMcpTools(availability: McpAvailability): CoachTool[] {
  return registry.filter((tool) => {
    if (tool.llmBacked) return false;
    if (tool.requires === "strava") return availability.stravaLinked;
    if (tool.requires === "intervals") return availability.intervalsConnected;
    return true;
  });
}

export function buildMcpContext(c: Context<TMcpEnv>): { ctx: CoachCtx; tools: CoachTool[] } {
  const user = c.get("user");
  const availability: McpAvailability = {
    stravaLinked: !!user?.stravaId,
    intervalsConnected: !!user?.intervalsAthleteId,
  };
  const ctx: CoachCtx = {
    db: c.env.db,
    userId: c.get("userId"),
    clerkUserId: c.get("clerkUserId"),
    stravaAccessToken: "",
    intervalsConnected: availability.intervalsConnected,
    userTime: new Date().toISOString(),
    logger: c.var.logger,
  };
  return { ctx, tools: selectMcpTools(availability) };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function buildMcpServer(ctx: CoachCtx, tools: CoachTool[]): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.params.shape },
      async (args): Promise<CallToolResult> => {
        if (tool.requires === "strava" && !ctx.stravaAccessToken) {
          try {
            const tokens = await getStravaAccessTokens(ctx.clerkUserId);
            ctx.stravaAccessToken = tokens.access_token;
          } catch {
            return toolError("Strava account is not linked or the session has expired.");
          }
        }

        const result = await runTool(tool.name, args ?? {}, ctx);
        if (result.error) return toolError(result.error);
        return { content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }] };
      },
    );
  }

  return server;
}
