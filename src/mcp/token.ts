import { and, eq, gt } from "drizzle-orm";
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from "jose";
import { auth } from "../auth";
import { db } from "../db";
import { logger } from "../logger";
import { oauthAccessTokens, oauthClients, sessions } from "../schema";
import { AUTH_ISSUER, hashOAuthToken, MCP_RESOURCE_URL } from "../services/oauth_server_tokens";

export type McpTokenClaims = {
  userId: string;
  scopes: string[];
};

const JWKS_TTL_MS = 5 * 60_000;
// An unknown `kid` forces a refetch, so an attacker minting random kids could
// drive one query per request without it.
const JWKS_REFETCH_COOLDOWN_MS = 10_000;
let jwksCache: { at: number; keySet: ReturnType<typeof createLocalJWKSet> } | null = null;

async function getKeySet(force: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
  const ttl = force ? JWKS_REFETCH_COOLDOWN_MS : JWKS_TTL_MS;
  if (jwksCache && Date.now() - jwksCache.at < ttl) return jwksCache.keySet;
  const jwks = (await auth.api.getJwks()) as JSONWebKeySet;
  const keySet = createLocalJWKSet(jwks);
  jwksCache = { at: Date.now(), keySet };
  return keySet;
}

async function clientIsUsable(clientId: unknown): Promise<boolean> {
  if (typeof clientId !== "string") return false;
  const [client] = await db
    .select({ disabled: oauthClients.disabled })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return !!client && !client.disabled;
}

async function verifyJwtAccessToken(token: string): Promise<JWTPayload | null> {
  for (const force of [false, true]) {
    try {
      const { payload } = await jwtVerify(token, await getKeySet(force), {
        audience: MCP_RESOURCE_URL,
        issuer: AUTH_ISSUER,
      });
      return payload;
    } catch (err) {
      const name = (err as Error).name;
      if (name === "JWSInvalid" || name === "JWTInvalid") return null;
      // A rotated signing key only shows up after a forced JWKS refetch.
      if (!force && (name === "JWKSNoMatchingKey" || name === "JWSSignatureVerificationFailed")) {
        continue;
      }
      return null;
    }
  }
  return null;
}

async function verifyOpaqueAccessToken(token: string): Promise<McpTokenClaims | null> {
  const [row] = await db
    .select({
      userId: oauthAccessTokens.userId,
      scopes: oauthAccessTokens.scopes,
      sessionId: oauthAccessTokens.sessionId,
      clientDisabled: oauthClients.disabled,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAccessTokens.clientId))
    .where(
      and(
        eq(oauthAccessTokens.token, hashOAuthToken(token)),
        gt(oauthAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || row.clientDisabled || !row.userId) return null;

  if (row.sessionId) {
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, row.sessionId), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!session) return null;
  }

  return { userId: row.userId, scopes: row.scopes };
}

/**
 * The provider only mints a JWT when the client sends RFC 8707 `resource` on the
 * token request; without it the token is opaque and carries no audience, so the
 * opaque path can only be trusted because this server is the sole resource.
 */
export async function verifyMcpAccessToken(token: string): Promise<McpTokenClaims | null> {
  try {
    const payload = await verifyJwtAccessToken(token);
    if (payload) {
      if (typeof payload.sub !== "string") return null;
      if (!(await clientIsUsable(payload.azp))) return null;
      const scope = typeof payload.scope === "string" ? payload.scope : "";
      return { userId: payload.sub, scopes: scope.split(" ").filter(Boolean) };
    }
    return await verifyOpaqueAccessToken(token);
  } catch (err) {
    logger.error({ err }, "mcp: access token verification failed unexpectedly");
    return null;
  }
}
