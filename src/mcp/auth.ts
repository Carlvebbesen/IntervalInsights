import { verifyClerkToken } from "@clerk/mcp-tools/server";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { config } from "../config";
import { logger } from "../logger";
import { users } from "../schema";
import { clerkClient } from "../services/clerk_client";
import type { TMcpEnv } from "./types";

const EXPECTED_RESOURCE = new URL("/mcp", config.APP_BASE_URL).toString();

function protectedResourceMetadataUrl(): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", config.APP_BASE_URL).toString();
}

/**
 * RFC 8707 defense: with Dynamic Client Registration enabled, ANY registered
 * OAuth app's token for ANY resource on this Clerk instance verifies here.
 * Clerk's AuthInfo exposes no audience, so inspect the JWT's `aud` claim
 * directly. Warn-only until real-world `aud` values are confirmed (Clerk may
 * set it to the client id rather than the resource) — flip
 * MCP_ENFORCE_AUDIENCE=true to enforce.
 */
function audienceMatches(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return true; // opaque token — verified network-side by Clerk
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      aud?: string | string[];
    };
    if (payload.aud == null) return true;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return auds.includes(EXPECTED_RESOURCE);
  } catch {
    return true;
  }
}

/**
 * Verifies the Clerk-issued OAuth access token an MCP client (Claude/ChatGPT)
 * presents, then resolves it to the internal user — mirroring `authGuard`, but
 * for `oauth_token`s instead of session tokens. On failure it replies 401 with a
 * `WWW-Authenticate` header pointing at the protected-resource metadata so the
 * client can start the OAuth flow.
 */
export const mcpAuth = createMiddleware<TMcpEnv>(async (c, next) => {
  const token = c.req.header("authorization")?.split(" ")[1];

  let authInfo: ReturnType<typeof verifyClerkToken>;
  try {
    const requestState = await clerkClient.authenticateRequest(c.req.raw, {
      acceptsToken: "oauth_token",
    });
    const auth = requestState.toAuth();
    authInfo = auth ? verifyClerkToken(auth, token) : undefined;
  } catch (err) {
    // A Clerk/network failure is not the client's fault: a 401 here would make
    // clients discard a valid token and restart the whole OAuth dance.
    logger.error({ err }, "mcp: token verification errored upstream");
    return c.json({ error: "Authorization service unavailable" }, 503);
  }

  const clerkUserId = authInfo?.extra?.userId;
  if (typeof clerkUserId !== "string") {
    c.header(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl()}"`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (token && !audienceMatches(token)) {
    logger.warn({ clerkUserId }, "mcp: token audience does not match this resource");
    if (config.MCP_ENFORCE_AUDIENCE) {
      c.header(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl()}"`,
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, clerkUserId),
  });
  if (!dbUser) {
    // Concurrent first-ever requests (initialize + tools/list) race this
    // insert; the loser must reuse the winner's row, not 500 on the unique key.
    const [created] = await c.env.db
      .insert(users)
      .values({ clerkId: clerkUserId, lastSeenAt: new Date() })
      .onConflictDoNothing({ target: users.clerkId })
      .returning();
    dbUser =
      created ?? (await c.env.db.query.users.findFirst({ where: eq(users.clerkId, clerkUserId) }));
  }
  if (!dbUser) {
    return c.json({ error: "Could not resolve user" }, 500);
  }

  c.set("clerkUserId", clerkUserId);
  c.set("userId", dbUser.id);
  c.set("user", dbUser);
  await next();
});
