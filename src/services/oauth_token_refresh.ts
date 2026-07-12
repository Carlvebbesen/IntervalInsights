import { db } from "../db";
import type { OAuthProvider } from "../schema";
import { readProviderToken, type StoredOAuthToken, writeProviderToken } from "./oauth_token_store";

const inflight = new Map<string, Promise<unknown>>();

export const getFreshOAuthTokens = <T>(opts: {
  provider: OAuthProvider;
  userId: string;
  read: (stored: StoredOAuthToken | null) => T;
  isExpired: (tokens: T) => boolean;
  refresh: (tokens: T) => Promise<T>;
  toStored: (tokens: T) => StoredOAuthToken;
}): Promise<T> => {
  const key = `${opts.provider}:${opts.userId}`;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const flight = (async () => {
    const storedRow = await readProviderToken(db, opts.userId, opts.provider);
    const tokens = opts.read(storedRow);
    if (!opts.isExpired(tokens)) return tokens;
    const fresh = await opts.refresh(tokens);
    await writeProviderToken(db, opts.userId, opts.provider, opts.toStored(fresh));
    return fresh;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, flight);
  return flight;
};
