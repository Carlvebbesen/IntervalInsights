import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { users } from "../../schema/users";
import type { TGlobalEnv } from "../../types/IRouters";
import { intervalsApiService } from "../../services.ts/intervals_api_service";

const intervalsAuthRouter = new Hono<TGlobalEnv>();

intervalsAuthRouter.post("/connect", async (c) => {
  try {
    const clerkUserId = c.get("clerkUserId");
    const body = await c.req.json();
    const { api_key } = body;

    if (!api_key || typeof api_key !== "string") {
      return c.json({ error: "API key is required" }, 400);
    }

    // Validate the API key by making a test call
    const athleteData = await intervalsApiService.getAthlete(api_key);
    const intervalsAthleteId = athleteData.id;

    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    await clerkClient.users.updateUserMetadata(clerkUserId, {
      privateMetadata: {
        intervals: { api_key },
      },
      publicMetadata: {
        intervals_connected: true,
      },
    });

    await c.env.db
      .update(users)
      .set({ intervalsAthleteId })
      .where(eq(users.clerkId, clerkUserId));

    console.log(`Linked Intervals.icu account for Clerk User: ${clerkUserId}, athlete: ${intervalsAthleteId}`);

    return c.json({
      success: true,
      message: "Intervals.icu connected successfully.",
    });
  } catch (error) {
    console.error("Intervals.icu connect error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

intervalsAuthRouter.post("/disconnect", async (c) => {
  try {
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
  } catch (error) {
    console.error("Intervals.icu disconnect error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
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
