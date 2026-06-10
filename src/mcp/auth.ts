import { createClerkClient } from "@clerk/backend";
import { verifyClerkToken } from "@clerk/mcp-tools/server";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { config } from "../config";
import { users } from "../schema";
import type { TMcpEnv } from "./types";

const clerkClient = createClerkClient({
  secretKey: config.CLERK_SECRET_KEY,
  publishableKey: config.CLERK_PUBLISHABLE_KEY,
});

function protectedResourceMetadataUrl(): string {
  return new URL("/.well-known/oauth-protected-resource/mcp", config.APP_BASE_URL).toString();
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

  const requestState = await clerkClient.authenticateRequest(c.req.raw, {
    acceptsToken: "oauth_token",
  });
  const auth = requestState.toAuth();
  const authInfo = auth ? verifyClerkToken(auth, token) : undefined;

  const clerkUserId = authInfo?.extra?.userId;
  if (typeof clerkUserId !== "string") {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, clerkUserId),
  });
  if (!dbUser) {
    const [created] = await c.env.db
      .insert(users)
      .values({ clerkId: clerkUserId, lastSeenAt: new Date() })
      .returning();
    dbUser = created;
  }

  c.set("clerkUserId", clerkUserId);
  c.set("userId", dbUser.id);
  c.set("user", dbUser);
  await next();
});
