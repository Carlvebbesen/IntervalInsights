import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { users } from "../schema";
import { protectedResourceMetadataUrl } from "../services/oauth_server_tokens";
import { verifyMcpAccessToken } from "./token";
import type { TMcpEnv } from "./types";

export const mcpAuth = createMiddleware<TMcpEnv>(async (c, next) => {
  const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const claims = token ? await verifyMcpAccessToken(token) : null;

  if (!claims) {
    c.header(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl()}"`,
    );
    c.header("Access-Control-Expose-Headers", "WWW-Authenticate");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const dbUser = await c.env.db.query.users.findFirst({ where: eq(users.id, claims.userId) });
  if (!dbUser) {
    return c.json({ error: "Could not resolve user" }, 401);
  }
  // Banning revokes sessions, but `oauth_access_tokens.session_id` is ON DELETE
  // SET NULL, so an outstanding grant survives it — this is the only gate.
  if (dbUser.banned) {
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("userId", dbUser.id);
  c.set("user", dbUser);
  c.set("scopes", claims.scopes);
  await next();
});
