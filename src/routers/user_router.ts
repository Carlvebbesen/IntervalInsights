import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_OF_SERVICE_VERSION,
} from "../consent_versions";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities, users } from "../schema";
import { ErrorSchema } from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const userRouter = new Hono<TGlobalEnv>();

const UserSchema = z.object({
  id: z.string(),
  clerkId: z.string(),
  stravaId: z.string().nullable(),
  role: z.enum(["guest", "premium", "admin"]).nullable(),
  maxHeartRate: z.number().nullable(),
  processHeartRate: z.boolean(),
  privacyPolicyAcceptedAt: z.string().nullable(),
  privacyPolicyVersion: z.string().nullable(),
  currentPrivacyPolicyVersion: z.string(),
  termsOfServiceAcceptedAt: z.string().nullable(),
  termsOfServiceVersion: z.string().nullable(),
  currentTermsOfServiceVersion: z.string(),
});

const UpdateUserSchema = z.object({
  maxHeartRate: z.number().int().positive().max(250).nullable().optional(),
  processHeartRate: z.boolean().optional(),
});

userRouter.get(
  "/",
  describeRoute({
    description: "Get the authenticated user's profile and consent settings",
    responses: {
      200: {
        description: "User profile",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    const user = await c.env.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({
      id: user.id,
      clerkId: user.clerkId,
      stravaId: user.stravaId,
      role: user.role,
      maxHeartRate: user.maxHeartRate,
      processHeartRate: user.processHeartRate,
      privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt?.toISOString() ?? null,
      privacyPolicyVersion: user.privacyPolicyVersion,
      currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      termsOfServiceAcceptedAt: user.termsOfServiceAcceptedAt?.toISOString() ?? null,
      termsOfServiceVersion: user.termsOfServiceVersion,
      currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
    });
  },
);

userRouter.post(
  "/accept-privacy-policy",
  describeRoute({
    description:
      "Record the authenticated user's acceptance of the current privacy policy version.",
    responses: {
      200: {
        description: "Acceptance recorded",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    const [updated] = await c.env.db
      .update(users)
      .set({
        privacyPolicyAcceptedAt: new Date(),
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      })
      .where(eq(users.id, userId))
      .returning();

    return c.json({
      id: updated.id,
      clerkId: updated.clerkId,
      stravaId: updated.stravaId,
      role: updated.role,
      maxHeartRate: updated.maxHeartRate,
      processHeartRate: updated.processHeartRate,
      privacyPolicyAcceptedAt: updated.privacyPolicyAcceptedAt?.toISOString() ?? null,
      privacyPolicyVersion: updated.privacyPolicyVersion,
      currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      termsOfServiceAcceptedAt: updated.termsOfServiceAcceptedAt?.toISOString() ?? null,
      termsOfServiceVersion: updated.termsOfServiceVersion,
      currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
    });
  },
);

userRouter.post(
  "/accept-terms-of-service",
  describeRoute({
    description:
      "Record the authenticated user's acceptance of the current terms of service version.",
    responses: {
      200: {
        description: "Acceptance recorded",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    const [updated] = await c.env.db
      .update(users)
      .set({
        termsOfServiceAcceptedAt: new Date(),
        termsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
      })
      .where(eq(users.id, userId))
      .returning();

    return c.json({
      id: updated.id,
      clerkId: updated.clerkId,
      stravaId: updated.stravaId,
      role: updated.role,
      maxHeartRate: updated.maxHeartRate,
      processHeartRate: updated.processHeartRate,
      privacyPolicyAcceptedAt: updated.privacyPolicyAcceptedAt?.toISOString() ?? null,
      privacyPolicyVersion: updated.privacyPolicyVersion,
      currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      termsOfServiceAcceptedAt: updated.termsOfServiceAcceptedAt?.toISOString() ?? null,
      termsOfServiceVersion: updated.termsOfServiceVersion,
      currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
    });
  },
);

userRouter.patch(
  "/",
  describeRoute({
    description:
      "Update the authenticated user's settings. processHeartRate is the GDPR Art 9 consent toggle for heart-rate processing.",
    responses: {
      200: {
        description: "Updated user profile",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
      400: {
        description: "Invalid body",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", UpdateUserSchema),
  async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");

    const updates: Partial<typeof users.$inferInsert> = {};

    if (body.maxHeartRate !== undefined) {
      updates.maxHeartRate = body.maxHeartRate;
    }

    if (body.processHeartRate !== undefined) {
      updates.processHeartRate = body.processHeartRate;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await c.env.db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning();

    return c.json({
      id: updated.id,
      clerkId: updated.clerkId,
      stravaId: updated.stravaId,
      role: updated.role,
      maxHeartRate: updated.maxHeartRate,
      processHeartRate: updated.processHeartRate,
      privacyPolicyAcceptedAt: updated.privacyPolicyAcceptedAt?.toISOString() ?? null,
      privacyPolicyVersion: updated.privacyPolicyVersion,
      currentPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      termsOfServiceAcceptedAt: updated.termsOfServiceAcceptedAt?.toISOString() ?? null,
      termsOfServiceVersion: updated.termsOfServiceVersion,
      currentTermsOfServiceVersion: CURRENT_TERMS_OF_SERVICE_VERSION,
    });
  },
);

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
