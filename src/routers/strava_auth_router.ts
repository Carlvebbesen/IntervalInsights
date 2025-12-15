import { Hono } from "hono";
import { getAuth } from '@hono/clerk-auth';
import { Bindings } from "../index"; 
import { createClerkClient } from "@clerk/backend";
import { env } from "bun";

const stravaAuthEndpoints = new Hono<{Bindings: Bindings}>();

const REDIRECT_URI = 'http://localhost:3000'; 

stravaAuthEndpoints.get('/url', (c) => {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID!,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    approval_prompt: 'force',
    scope: 'read,read_all,activity:read_all',
  });

  return c.json({ url: `https://www.strava.com/oauth/authorize?${params.toString()}` });
});

stravaAuthEndpoints.post('/exchange', async (c) => {
  try {
    const auth = getAuth(c);
    if (!auth?.userId) {
      return c.json({ error: 'You must be logged in to connect Strava.' }, 401);
    }

    const body = await c.req.json();
    const { code } = body;

    if (!code) return c.json({ error: 'Authorization code is missing' }, 400);

    // 1. Exchange code for Strava tokens
    const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('Strava Error:', tokenData);
      return c.json({ error: 'Failed to exchange token with Strava' }, 401);
    }

    // 2. Initialize Clerk Client
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

    // 3. Save Strava Keys to Clerk PRIVATE Metadata
    // privateMetadata is ONLY accessible by the Backend API
    await clerkClient.users.updateUserMetadata(auth.userId, {
      privateMetadata: {
        strava: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_at,
          athlete_id: tokenData.athlete.id // Strava returns athlete object on initial exchange
        }
      },
      // Optional: Flag for frontend UI to know it's connected
      publicMetadata: {
        strava_connected: true
      }
    });
    
    console.log(`Linked Strava account for Clerk User: ${auth.userId}`);

    return c.json({ 
      success: true, 
      message: 'Strava connected successfully.',
    });

  } catch (error) {
    console.error(error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default stravaAuthEndpoints;