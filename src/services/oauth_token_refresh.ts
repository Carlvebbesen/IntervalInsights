import { clerkClient } from "./clerk_client";

type OAuthProvider = "strava" | "intervals";

// In-process single-flight only: fine on a single Railway replica. If we ever
// run multiple replicas, replace with a Postgres advisory lock.
const inflight = new Map<string, Promise<unknown>>();

/**
 * Read the provider tokens from Clerk private metadata and refresh-and-persist
 * them when expired. Concurrent calls for the same user+provider share one
 * flight, so at most one refresh POST hits the provider — a second concurrent
 * refresh with the same (rotated) refresh_token would 401 a healthy account.
 * The refreshed tokens are persisted before being returned; if the metadata
 * write fails, the caller never sees a token that wasn't stored.
 */
export const getFreshOAuthTokens = <T>(opts: {
  provider: OAuthProvider;
  clerkUserId: string;
  /** Extract the provider's tokens; throw the provider's not-linked error when absent. */
  read: (privateMetadata: Record<string, unknown>) => T;
  isExpired: (tokens: T) => boolean;
  /** Perform the refresh grant; throw the provider's session-expired error on failure. */
  refresh: (tokens: T) => Promise<T>;
}): Promise<T> => {
  const key = `${opts.provider}:${opts.clerkUserId}`;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const flight = (async () => {
    const user = await clerkClient.users.getUser(opts.clerkUserId);
    const stored = opts.read(user.privateMetadata as Record<string, unknown>);
    if (!opts.isExpired(stored)) return stored;
    const fresh = await opts.refresh(stored);
    await clerkClient.users.updateUserMetadata(opts.clerkUserId, {
      privateMetadata: { [opts.provider]: fresh },
    });
    return fresh;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, flight);
  return flight;
};
