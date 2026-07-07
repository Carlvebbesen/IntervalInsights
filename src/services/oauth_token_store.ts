import { and, eq } from "drizzle-orm";
import { type OAuthProvider, oauthProviderTokens } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { decryptToken, encryptToken } from "./token_crypto";

type Db = IGlobalBindings["db"];

/**
 * Provider-agnostic token shape, mirroring the old Clerk `privateMetadata`
 * payload. `expires_at` stays Unix epoch seconds so the middleware refresh logic
 * is unchanged; the DB column is a proper `timestamp` and is converted here.
 */
export interface StoredOAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  athlete_id?: string;
}

/** Decrypt and return the stored tokens for (user, provider), or null when unlinked. */
export async function readProviderToken(
  db: Db,
  userId: string,
  provider: OAuthProvider,
): Promise<StoredOAuthToken | null> {
  const row = await db.query.oauthProviderTokens.findFirst({
    where: and(eq(oauthProviderTokens.userId, userId), eq(oauthProviderTokens.provider, provider)),
  });
  if (!row) return null;
  return {
    access_token: await decryptToken(row.accessToken),
    refresh_token: row.refreshToken ? await decryptToken(row.refreshToken) : undefined,
    expires_at: row.expiresAt ? Math.floor(row.expiresAt.getTime() / 1000) : undefined,
    athlete_id: row.athleteId ?? undefined,
  };
}

/** Encrypt and upsert the tokens for (user, provider). */
export async function writeProviderToken(
  db: Db,
  userId: string,
  provider: OAuthProvider,
  token: StoredOAuthToken,
): Promise<void> {
  const accessToken = await encryptToken(token.access_token);
  const refreshToken = token.refresh_token ? await encryptToken(token.refresh_token) : null;
  const expiresAt = token.expires_at != null ? new Date(token.expires_at * 1000) : null;
  const athleteId = token.athlete_id ?? null;

  await db
    .insert(oauthProviderTokens)
    .values({ userId, provider, accessToken, refreshToken, expiresAt, athleteId })
    .onConflictDoUpdate({
      target: [oauthProviderTokens.userId, oauthProviderTokens.provider],
      set: { accessToken, refreshToken, expiresAt, athleteId, updatedAt: new Date() },
    });
}

/** Remove the stored tokens for (user, provider). No-op when already unlinked. */
export async function deleteProviderToken(
  db: Db,
  userId: string,
  provider: OAuthProvider,
): Promise<void> {
  await db
    .delete(oauthProviderTokens)
    .where(and(eq(oauthProviderTokens.userId, userId), eq(oauthProviderTokens.provider, provider)));
}
