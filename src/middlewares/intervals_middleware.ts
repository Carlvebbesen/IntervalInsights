import { createMiddleware } from "hono/factory";
import { IntervalsError } from "../error";
import {
  INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET,
  INTERVALS_TOKEN_URL,
} from "../routers/intervals/intervals_oauth_config";
import { getFreshOAuthTokens } from "../services/oauth_token_refresh";
import type { StoredOAuthToken } from "../services/oauth_token_store";
import type { TIntervalsEnv } from "../types/IRouters";
import type { IIntervalsTokenResponse } from "../types/intervals/IIntervalsAuth";

interface IntervalsTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  athlete_id?: string;
}

export const getIntervalsAccessToken = async (userId: string): Promise<string> => {
  const tokens = await getFreshOAuthTokens<IntervalsTokens>({
    provider: "intervals",
    userId,
    read: (stored) => {
      if (!stored?.access_token) {
        throw new IntervalsError(403, "Intervals.icu account not linked");
      }
      return {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_at: stored.expires_at,
        athlete_id: stored.athlete_id,
      };
    },
    isExpired: (tokens) =>
      tokens.expires_at != null && tokens.expires_at < Math.floor(Date.now() / 1000) + 300,
    refresh: async (tokens) => {
      if (!tokens.refresh_token) {
        throw new IntervalsError(401, "Intervals.icu session expired");
      }
      const refreshResponse = await fetch(INTERVALS_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: INTERVALS_CLIENT_ID,
          client_secret: INTERVALS_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }),
      });

      if (!refreshResponse.ok) {
        throw new IntervalsError(401, "Intervals.icu session expired");
      }
      const data = (await refreshResponse.json()) as IIntervalsTokenResponse;
      const nowSecs = Math.floor(Date.now() / 1000);
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? tokens.refresh_token,
        expires_at: data.expires_in != null ? nowSecs + data.expires_in : tokens.expires_at,
        athlete_id: tokens.athlete_id,
      };
    },
    toStored: (tokens): StoredOAuthToken => tokens,
  });
  return tokens.access_token;
};

export const intervalsMiddleware = createMiddleware<TIntervalsEnv>(async (c, next) => {
  const userId = c.get("userId");
  const accessToken = await getIntervalsAccessToken(userId);
  c.set("intervalsAccessToken", accessToken);
  await next();
});
