import { createMiddleware } from "hono/factory";
import { config } from "../config";
import { StravaError } from "../error";
import { getFreshOAuthTokens } from "../services/oauth_token_refresh";
import type { StoredOAuthToken } from "../services/oauth_token_store";
import type { TStravaEnv } from "../types/IRouters";

interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
}

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete_id?: number;
}

export const getStravaAccessTokens = (userId: string) =>
  getFreshOAuthTokens<StravaTokens>({
    provider: "strava",
    userId,
    read: (stored) => {
      if (!stored?.access_token || !stored?.refresh_token) {
        throw new StravaError(403, "Strava account not linked");
      }
      return {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_at: stored.expires_at ?? 0,
        athlete_id: stored.athlete_id != null ? Number(stored.athlete_id) : undefined,
      };
    },
    isExpired: (tokens) => tokens.expires_at < Math.floor(Date.now() / 1000) + 300,
    refresh: async (tokens) => {
      const refreshResponse = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.STRAVA_CLIENT_ID,
          client_secret: config.STRAVA_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }),
      });

      if (!refreshResponse.ok) {
        throw new StravaError(401, "Strava session expired");
      }
      const data = (await refreshResponse.json()) as StravaTokenResponse;
      return {
        access_token: data.access_token,
        // A refresh response can omit the token when it's unchanged; keep the old one.
        refresh_token: data.refresh_token ?? tokens.refresh_token,
        expires_at: data.expires_at,
        athlete_id: tokens.athlete_id,
      };
    },
    toStored: (tokens): StoredOAuthToken => ({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      athlete_id: tokens.athlete_id != null ? String(tokens.athlete_id) : undefined,
    }),
  });

export const stravaMiddleware = createMiddleware<TStravaEnv>(async (c, next) => {
  const userId = c.get("userId");
  const tokens = await getStravaAccessTokens(userId);
  c.set("stravaAccessToken", tokens.access_token);
  c.set("stravaAthleteId", tokens.athlete_id);
  await next();
});

// Token-optional variant: resolves the Strava token when the user has one but
// passes through (leaving it unset) when they don't, instead of 403ing. Use it
// on routes that degrade gracefully without Strava — e.g. GET /pending, which
// only touches Strava to re-queue stale rows. This also covers migrated users
// whose `users.stravaId` is set but whose token vault hasn't been backfilled.
export const softStravaMiddleware = createMiddleware<TStravaEnv>(async (c, next) => {
  const userId = c.get("userId");
  try {
    const tokens = await getStravaAccessTokens(userId);
    c.set("stravaAccessToken", tokens.access_token);
    c.set("stravaAthleteId", tokens.athlete_id);
  } catch (err) {
    if (!(err instanceof StravaError)) throw err;
  }
  await next();
});
