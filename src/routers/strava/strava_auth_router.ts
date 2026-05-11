import { createClerkClient } from "@clerk/backend";
import { getAuth } from "@hono/clerk-auth";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { users } from "../../schema/users";
import { ErrorSchema } from "../../schemas/api_schemas";
import type { TGlobalEnv } from "../../types/IRouters";

const stravaAuthRouter = new Hono<TGlobalEnv>();

const REDIRECT_URI = "https://intervalinsights.cvebbesen.no/strava-callback";

const STRAVA_CLIENT_ID = (() => {
  const value = env.STRAVA_CLIENT_ID;
  if (!value) throw new Error("Missing required env var: STRAVA_CLIENT_ID");
  return value;
})();

const StravaAuthUrlResponseSchema = z.object({
  url: z.string().url(),
});

const StravaExchangeBodySchema = z.object({
  code: z.string(),
});

const StravaExchangeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

stravaAuthRouter.get(
  "/url",
  describeRoute({
    description:
      "Build the Strava OAuth authorization URL the client should redirect the user to. Always returns the same URL pattern for the configured client.",
    responses: {
      200: {
        description: "Authorization URL",
        content: {
          "application/json": { schema: resolver(StravaAuthUrlResponseSchema) },
        },
      },
    },
  }),
  (c) => {
    const params = new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      approval_prompt: "force",
      scope: "read,read_all,activity:read_all",
    });

    return c.json({
      url: `https://www.strava.com/oauth/mobile/authorize?${params.toString()}`,
    });
  },
);

stravaAuthRouter.post(
  "/exchange",
  describeRoute({
    description:
      "Exchange a Strava OAuth `code` for tokens, store them in Clerk private metadata, and link the Strava athlete to the authenticated Clerk user.",
    responses: {
      200: {
        description: "Strava account linked",
        content: {
          "application/json": { schema: resolver(StravaExchangeResponseSchema) },
        },
      },
      400: {
        description: "Missing authorization code",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      401: {
        description: "Not signed in to Clerk, or Strava rejected the code",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", StravaExchangeBodySchema),
  async (c) => {
    try {
      const auth = getAuth(c);
      if (!auth?.userId) {
        return c.json({ error: "You must be logged in to connect Strava." }, 401);
      }

      const { code } = c.req.valid("json");

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
          await c.env.db.update(users).set({ stravaId }).where(eq(users.clerkId, auth.userId));
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
  },
);

export default stravaAuthRouter;
