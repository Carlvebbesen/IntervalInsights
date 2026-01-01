import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from 'hono/factory';
import { TStravaEnv } from '../types/IRouters';
import { env } from "bun";


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
export const stravaMiddleware = createMiddleware<TStravaEnv>(async (c, next) => {
  const clerkUserId = c.get('clerkUserId'); 
  try {
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const user = await clerkClient.users.getUser(clerkUserId);
    
    const metadata = user.privateMetadata as UserMetadata; 
    let tokens = metadata.strava;
    if (!tokens?.access_token || !tokens?.refresh_token) {
      return c.json({ error: 'Strava account not linked' }, 403);
    }

    const isExpired = tokens.expires_at < (Math.floor(Date.now() / 1000) + 300);

    if (isExpired) {
      const refreshResponse = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        }),
      });

      if (!refreshResponse.ok) return c.json({ error: 'Strava session expired' }, 401);

      const data = await refreshResponse.json() as StravaTokenResponse;
      tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete_id: tokens.athlete_id,
      };
      await clerkClient.users.updateUserMetadata(clerkUserId, {
        privateMetadata: { strava: tokens }
      });
    }
    c.set('stravaAccessToken', tokens.access_token);
    c.set('stravaAthleteId', tokens.athlete_id);
    await next();
  } catch (error) {
    console.error('Strava Middleware Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});