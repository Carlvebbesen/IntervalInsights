import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { createMiddleware } from "hono/factory";
import { IntervalsError } from "../error";
import {
  INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET,
  INTERVALS_TOKEN_URL,
} from "../routers/intervals/intervals_oauth_config";
import type { TIntervalsEnv } from "../types/IRouters";
import type { IIntervalsTokenResponse } from "../types/intervals/IIntervalsAuth";

interface IntervalsClerkData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  athlete_id?: string;
}

type UserMetadata = {
  intervals?: IntervalsClerkData;
};

export const getIntervalsAccessToken = async (clerkUserId: string): Promise<string> => {
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const user = await clerkClient.users.getUser(clerkUserId);
  const metadata = user.privateMetadata as UserMetadata;
  let tokens = metadata.intervals;

  if (!tokens?.access_token) {
    throw new IntervalsError(403, "Intervals.icu account not linked");
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const isExpired = tokens.expires_at != null && tokens.expires_at < nowSecs + 300;
  if (isExpired) {
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
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: data.expires_in != null ? nowSecs + data.expires_in : tokens.expires_at,
      athlete_id: tokens.athlete_id,
    };
    await clerkClient.users.updateUserMetadata(clerkUserId, {
      privateMetadata: { intervals: tokens },
    });
  }
  return tokens.access_token;
};

export const intervalsMiddleware = createMiddleware<TIntervalsEnv>(async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  const accessToken = await getIntervalsAccessToken(clerkUserId);
  c.set("intervalsAccessToken", accessToken);
  await next();
});
