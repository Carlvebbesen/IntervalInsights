import { Hono } from "hono";
import { TGlobalEnv } from "../types/IRouters";
import { eq } from "drizzle-orm";
import { activities, users } from "../schema";
import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";

const userRouter = new Hono<TGlobalEnv>();

userRouter.delete("/data", async (c) => {
  const userId = c.get("userId");
  const clerkUserId = c.get("clerkUserId");
  const db = c.env.db;

  // Delete all activities (interval_segments cascade via ON DELETE CASCADE)
  await db.delete(activities).where(eq(activities.userId, userId));

  // Delete the user record
  await db.delete(users).where(eq(users.id, userId));

  // Revoke Strava access and clear Clerk metadata
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const tokens = await getStravaAccessTokens(clerkUserId);
    await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: tokens.access_token }),
    });
  } catch {
    // Strava may not be linked — continue with cleanup
  }

  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: { strava: null },
    publicMetadata: { strava_connected: false, userId: null, role: null },
  });

  return c.json({ success: true, message: "All user data deleted" });
});

export default userRouter;
