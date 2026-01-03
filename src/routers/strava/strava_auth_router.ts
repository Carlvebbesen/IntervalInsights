import { Hono } from "hono";
import { getAuth } from "@hono/clerk-auth";
import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { TGlobalEnv } from "../../types/IRouters";
import { users } from "../../schema/users";

const stravaAuthRouter = new Hono<TGlobalEnv>();

const REDIRECT_URI = "https://intervalinsights.ebbesen.org";

stravaAuthRouter.get("/url", (c) => {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID!,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    approval_prompt: "force",
    scope: "read,read_all,activity:read_all",
  });

  return c.json({
    url: `https://www.strava.com/oauth/authorize?${params.toString()}`,
  });
});

stravaAuthRouter.post("/exchange", async (c) => {
  try {
    const auth = getAuth(c);
    if (!auth?.userId) {
      return c.json({ error: "You must be logged in to connect Strava." }, 401);
    }

    const body = await c.req.json();
    const { code } = body;

    if (!code) return c.json({ error: "Authorization code is missing" }, 400);

    const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("Strava Error:", tokenData);
      return c.json({ error: "Failed to exchange token with Strava" }, 401);
    }
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    await clerkClient.users.updateUserMetadata(auth.userId, {
      privateMetadata: {
        strava: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_at,
          athlete_id: tokenData.athlete.id,
        },
      },
      publicMetadata: {
        strava_connected: true,
      },
    });
    const stravaId = String(tokenData.athlete.id);
    const existingUser = await c.env.db.query.users.findFirst({
      where: eq(users.clerkId, auth.userId),
    });

    if (existingUser) {
      if (!existingUser.stravaId) {
        await c.env.db
          .update(users)
          .set({ stravaId })
          .where(eq(users.clerkId, auth.userId));
        console.log(`Updated Strava ID for existing user: ${auth.userId}`);
      }
    } else {
      await c.env.db.insert(users).values({
        clerkId: auth.userId,
        stravaId,
      });
      console.log(`Created new user record for Clerk User: ${auth.userId}`);
    }

    console.log(`Linked Strava account for Clerk User: ${auth.userId}`);

    return c.json({
      success: true,
      message: "Strava connected successfully.",
    });
  } catch (error) {
    console.error(error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default stravaAuthRouter;
