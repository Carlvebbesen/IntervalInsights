import {
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from "@clerk/mcp-tools/server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { config } from "../config";
import { db } from "../db";
import { mcpAuth } from "../mcp/auth";
import { buildMcpContext, buildMcpServer } from "../mcp/server";
import type { TMcpEnv } from "../mcp/types";

const mcpRouter = new Hono<TMcpEnv>();

const RESOURCE_URL = new URL("/mcp", config.APP_BASE_URL).toString();

mcpRouter.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(
    generateClerkProtectedResourceMetadata({
      publishableKey: config.CLERK_PUBLISHABLE_KEY,
      resourceUrl: RESOURCE_URL,
      properties: {
        scopes_supported: ["profile", "email", "offline_access"],
      },
    }),
  ),
);

const AS_METADATA_TTL_MS = 5 * 60_000;
let asMetadataCache: { at: number; value: Record<string, unknown> } | null = null;

mcpRouter.get("/.well-known/oauth-authorization-server", async (c) => {
  if (asMetadataCache && Date.now() - asMetadataCache.at < AS_METADATA_TTL_MS) {
    return c.json(asMetadataCache.value);
  }
  try {
    const value = (await fetchClerkAuthorizationServerMetadata({
      publishableKey: config.CLERK_PUBLISHABLE_KEY,
    })) as Record<string, unknown>;
    asMetadataCache = { at: Date.now(), value };
    return c.json(value);
  } catch {
    return c.json({ error: "Authorization server metadata unavailable" }, 503);
  }
});

mcpRouter.use("/mcp", async (c, next) => {
  c.env.db = db;
  await next();
});
mcpRouter.use("/mcp", mcpAuth);

mcpRouter.post("/mcp", async (c) => {
  const { ctx, tools } = buildMcpContext(c);
  const server = buildMcpServer(ctx, tools);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.body(null, 202);
});

mcpRouter.all("/mcp", (c) => c.json({ error: "Method not allowed" }, 405));

export default mcpRouter;
