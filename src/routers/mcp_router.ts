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

// Public OAuth discovery documents (RFC 9728 + RFC 8414). MCP clients fetch
// these unauthenticated to learn where to authenticate (Clerk).
mcpRouter.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(
    generateClerkProtectedResourceMetadata({
      publishableKey: config.CLERK_PUBLISHABLE_KEY,
      resourceUrl: RESOURCE_URL,
    }),
  ),
);

mcpRouter.get("/.well-known/oauth-authorization-server", async (c) =>
  c.json(
    await fetchClerkAuthorizationServerMetadata({
      publishableKey: config.CLERK_PUBLISHABLE_KEY,
    }),
  ),
);

// The MCP endpoint itself: outside the `/api/*` session-auth chain, so it injects
// its own db handle and verifies OAuth tokens instead of Clerk session tokens.
mcpRouter.use("/mcp", async (c, next) => {
  c.env.db = db;
  await next();
});
mcpRouter.use("/mcp", mcpAuth);

mcpRouter.all("/mcp", async (c) => {
  const { ctx, tools } = buildMcpContext(c);
  const server = buildMcpServer(ctx, tools);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.body(null, 202);
});

export default mcpRouter;
