import { eq } from "drizzle-orm";
import { db } from "../db";
import { type OAuthProvider, users } from "../schema";
import { readProviderToken, type StoredOAuthToken, writeProviderToken } from "./oauth_token_store";

// In-process single-flight only: fine on a single Railway replica. If we ever
// run multiple replicas, replace with a Postgres advisory lock.
const inflight = new Map<string, Promise<unknown>>();

/**
 * Read the provider tokens from Postgres (`oauth_provider_tokens`, encrypted at
 * rest) and refresh-and-persist them when expired. Concurrent calls for the same
 * user+provider share one flight, so at most one refresh POST hits the provider —
 * a second concurrent refresh with the same (rotated) refresh_token would 401 a
 * healthy account. The refreshed tokens are persisted before being returned; if
 * the DB write fails, the caller never sees a token that wasn't stored.
 *
 * Keyed externally by `clerkUserId` (unchanged call sites); resolved internally
 * to the internal `users.id`, which owns the token rows. A missing user or a
 * missing token row surfaces as `read(null)` so each provider throws its own
 * "not linked" error.
 */
export const getFreshOAuthTokens = <T>(opts: {
  provider: OAuthProvider;
  clerkUserId: string;
  /** Validate + narrow the stored tokens; throw the provider's not-linked error when null. */
  read: (stored: StoredOAuthToken | null) => T;
  isExpired: (tokens: T) => boolean;
  /** Perform the refresh grant; throw the provider's session-expired error on failure. */
  refresh: (tokens: T) => Promise<T>;
  /** Map the provider's token shape back to the storable shape for persistence. */
  toStored: (tokens: T) => StoredOAuthToken;
}): Promise<T> => {
  const key = `${opts.provider}:${opts.clerkUserId}`;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const flight = (async () => {
    const userRow = await db.query.users.findFirst({
      columns: { id: true },
      where: eq(users.clerkId, opts.clerkUserId),
    });
    const storedRow = userRow ? await readProviderToken(db, userRow.id, opts.provider) : null;
    const tokens = opts.read(storedRow);
    if (!opts.isExpired(tokens)) return tokens;
    const fresh = await opts.refresh(tokens);
    // userRow is non-null here: a non-null token row implies the user exists.
    if (userRow) await writeProviderToken(db, userRow.id, opts.provider, opts.toStored(fresh));
    return fresh;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, flight);
  return flight;
};
