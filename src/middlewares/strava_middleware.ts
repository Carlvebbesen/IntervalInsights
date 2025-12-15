import { Context, Next } from 'hono';
import { Bindings } from '..';
import { createClerkClient } from "@clerk/backend";
import { env } from 'bun';

// 1. Define Variables
type Variables = {
  stravaAccessToken: string;
  stravaAthleteId: number|undefined; 
};

// 2. Define Types
interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
}

// Data shape stored in Clerk Metadata
interface StravaClerkData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete_id?: number;
}

// Helper to type the Clerk User Metadata
type UserMetadata = {
  strava?: StravaClerkData;
};

export const stravaMiddleware = async (
  c: Context<{ Bindings: Bindings; Variables: Variables }>, 
  next: Next
) => {
  // We assume you are using Clerk Auth Middleware before this, 
  // so we can trust the Auth State or Header.
  // Ideally, use: const auth = getAuth(c); but we will stick to your header logic if preferred.
  const clerkUserId = c.req.header('X-Clerk-User-Id'); 

  if (!clerkUserId) {
    return c.json({ error: 'Missing Clerk User ID' }, 401);
  }

  try {
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

    // 1. Fetch User from Clerk to get Metadata
    // Note: This adds latency (HTTP call to Clerk). 
    const user = await clerkClient.users.getUser(clerkUserId);
    
    // Unsafe cast for brevity, but in production validate this shape using Zod
    const metadata = user.privateMetadata as UserMetadata; 
    let tokens = metadata.strava;

    if (!tokens) {
      return c.json({ error: 'Strava account not linked' }, 404);
    }

    // 2. Check Expiration (Buffer: 5 minutes)
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const isExpired = tokens.expires_at < (nowInSeconds + 300);

    if (isExpired) {
      console.log(`Token expired for user ${clerkUserId}. Refreshing...`);

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

      if (!refreshResponse.ok) {
        console.error('Failed to refresh Strava token');
        // Optional: clear metadata if refresh fails (revoked access)
        return c.json({ error: 'Failed to refresh Strava session' }, 401);
      }

      const refreshedData = await refreshResponse.json() as StravaTokenResponse;

      // Update local object
      tokens = {
        access_token: refreshedData.access_token,
        refresh_token: refreshedData.refresh_token,
        expires_at: refreshedData.expires_at,
        athlete_id: tokens.athlete_id,
      };
      await clerkClient.users.updateUserMetadata(clerkUserId, {
        privateMetadata: {
          strava: tokens
        }
      });
      
      console.log('Refreshed token saved to Clerk metadata');
    }
    c.set('stravaAccessToken', tokens.access_token);
    c.set('stravaAthleteId', tokens.athlete_id);
    c.req.raw.headers.set('Authorization', `Bearer ${tokens.access_token}`);

    await next();

  } catch (error) {
    console.error('Middleware Error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
};