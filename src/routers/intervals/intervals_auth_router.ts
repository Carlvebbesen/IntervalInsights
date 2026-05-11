import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { IntervalsError } from "../../error";
import { users } from "../../schema/users";
import { intervalsApiService } from "../../services.ts/intervals_api_service";
import type { TGlobalEnv } from "../../types/IRouters";
import {
  INTERVALS_AUTHORIZE_URL,
  INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET,
  INTERVALS_REDIRECT_URI,
  INTERVALS_SCOPES,
  INTERVALS_TOKEN_URL,
} from "./intervals_oauth_config";

const intervalsAuthRouter = new Hono<TGlobalEnv>();

interface IntervalsTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  athlete_id?: string;
  token_type?: string;
  scope?: string;
}

const ExchangeBodySchema = z.object({
  code: z.string(),
});

intervalsAuthRouter.get("/url", (c) => {
  const params = new URLSearchParams({
    client_id: INTERVALS_CLIENT_ID,
    redirect_uri: INTERVALS_REDIRECT_URI,
    response_type: "code",
    scope: INTERVALS_SCOPES,
  });

  return c.json({
    url: `${INTERVALS_AUTHORIZE_URL}?${params.toString()}`,
  });
});

intervalsAuthRouter.post("/exchange", validator("json", ExchangeBodySchema), async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const { code } = c.req.valid("json");

  const tokenResponse = await fetch(INTERVALS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: INTERVALS_CLIENT_ID,
      client_secret: INTERVALS_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: INTERVALS_REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse
      .json()
      .catch(() => ({ message: tokenResponse.statusText }));
    console.error("Intervals.icu token exchange failed:", errorBody);
    throw new IntervalsError(401, "Failed to exchange code with Intervals.icu");
  }

  const tokenData = (await tokenResponse.json()) as IntervalsTokenResponse;
  const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

  const athlete =
    tokenData.athlete_id != null
      ? { id: tokenData.athlete_id }
      : await intervalsApiService.getAthlete(tokenData.access_token);

  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: {
      intervals: {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        athlete_id: athlete.id,
      },
    },
    publicMetadata: {
      intervals_connected: true,
    },
  });

  await c.env.db
    .update(users)
    .set({ intervalsAthleteId: athlete.id })
    .where(eq(users.clerkId, clerkUserId));

  console.log(
    `Linked Intervals.icu account for Clerk User: ${clerkUserId}, athlete: ${athlete.id}`,
  );

  return c.json({
    success: true,
    message: "Intervals.icu connected successfully.",
  });
});

intervalsAuthRouter.post("/disconnect", async (c) => {
  const clerkUserId = c.get("clerkUserId");

  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: {
      intervals: null,
    },
    publicMetadata: {
      intervals_connected: false,
    },
  });

  await c.env.db
    .update(users)
    .set({ intervalsAthleteId: null })
    .where(eq(users.clerkId, clerkUserId));

  console.log(`Disconnected Intervals.icu for Clerk User: ${clerkUserId}`);

  return c.json({
    success: true,
    message: "Intervals.icu disconnected.",
  });
});

intervalsAuthRouter.get("/status", async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const user = await clerkClient.users.getUser(clerkUserId);
  const metadata = user.publicMetadata;
  const connected = "intervals_connected" in metadata && metadata.intervals_connected === true;
  return c.json({ connected });
});

export default intervalsAuthRouter;
