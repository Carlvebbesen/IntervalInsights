import { createMiddleware } from "hono/factory";
import { config } from "../config";
import { StravaError } from "../error";
import { getFreshOAuthTokens } from "../services/oauth_token_refresh";
import type { TStravaEnv } from "../types/IRouters";

interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
}
interface StravaClerkData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete_id?: number;
}
type UserMetadata = {
  strava?: StravaClerkData;
};

export const getStravaAccessTokens = (clerkUserId: string) =>
  getFreshOAuthTokens<StravaClerkData>({
    provider: "strava",
    clerkUserId,
    read: (privateMetadata) => {
      const tokens = (privateMetadata as UserMetadata).strava;
      if (!tokens?.access_token || !tokens?.refresh_token) {
        throw new StravaError(403, "Strava account not linked");
      }
      return tokens;
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
  });

export const stravaMiddleware = createMiddleware<TStravaEnv>(async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  const tokens = await getStravaAccessTokens(clerkUserId);
  c.set("stravaAccessToken", tokens.access_token);
  c.set("stravaAthleteId", tokens.athlete_id);
  await next();
});
