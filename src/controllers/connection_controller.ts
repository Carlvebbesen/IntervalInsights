import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { AppError } from "../error";
import { oauthAccessTokens, oauthClients, oauthConsents, oauthRefreshTokens } from "../schema";
import type { McpConnectionSchema } from "../schemas/user_schemas";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];
type McpConnection = z.infer<typeof McpConnectionSchema>;

/**
 * The MCP/OAuth clients a user has authorized. A consent row is the durable
 * "this client is connected" record — one per (user, client) — so the list is
 * driven off consents, joined to the client for its display name.
 */
export async function listConnections(db: Db, userId: string): Promise<McpConnection[]> {
  const rows = await db
    .select({
      clientId: oauthConsents.clientId,
      name: oauthClients.name,
      uri: oauthClients.uri,
      scopes: oauthConsents.scopes,
      connectedAt: oauthConsents.createdAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, userId))
    .orderBy(desc(oauthConsents.createdAt));

  return rows.map((r) => ({
    clientId: r.clientId,
    name: r.name,
    uri: r.uri,
    scopes: r.scopes,
    connectedAt: r.connectedAt.toISOString(),
  }));
}

/**
 * Disconnect a client: drop the consent (so a reconnect must re-consent) and
 * every token issued to it for this user. Deleting the consent also invalidates
 * outstanding JWTs on their next call — see `jwtGrantValid` in `mcp/token.ts`.
 */
export async function revokeConnection(db: Db, userId: string, clientId: string): Promise<void> {
  const [consent] = await db
    .select({ id: oauthConsents.id })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
    .limit(1);
  if (!consent) {
    throw new AppError(404, "Connection not found");
  }

  await db
    .delete(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)));
  await db
    .delete(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId)));
  await db
    .delete(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientId)));
}
