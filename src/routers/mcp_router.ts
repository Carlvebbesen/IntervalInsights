import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { auth } from "../auth";
import { db } from "../db";
import { mcpAuth } from "../mcp/auth";
import { buildMcpContext, buildMcpServer } from "../mcp/server";
import type { TMcpEnv } from "../mcp/types";
import { AUTH_ISSUER, MCP_RESOURCE_URL, MCP_SCOPES } from "../services/oauth_server_tokens";

const mcpRouter = new Hono<TMcpEnv>();

const protectedResourceMetadata = {
  resource: MCP_RESOURCE_URL,
  authorization_servers: [AUTH_ISSUER],
  scopes_supported: MCP_SCOPES,
  bearer_methods_supported: ["header"],
};

for (const path of [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
]) {
  mcpRouter.get(path, (c) => c.json(protectedResourceMetadata));
}

// Better Auth serves these under its own basePath; clients look for them at the
// root and at the RFC 8414 path-insertion form derived from the issuer.
const authServerMetadata = oauthProviderAuthServerMetadata(auth);
for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]) {
  mcpRouter.get(path, (c) => authServerMetadata(c.req.raw));
}

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
