import { createAuthEndpoint } from "@better-auth/core/api";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { z } from "zod";
import { config } from "./config";
import { db } from "./db";
import { logger } from "./logger";
import * as schema from "./schema";
import { sendSignInOtpEmail } from "./services/auth_email";
import { isReviewAccountEmail } from "./services/review_account";

const expoOriginBridge = {
  id: "expo-origin-bridge",
  async onRequest(request: Request) {
    if (request.headers.get("origin")) return;
    const expoOrigin = request.headers.get("expo-origin");
    if (!expoOrigin) return;
    const headers = new Headers(request.headers);
    headers.set("origin", expoOrigin);
    return { request: new Request(request, { headers }) };
  },
} satisfies BetterAuthPlugin;

const signUpEmailOtp = {
  id: "signup-email-otp",
  endpoints: {
    signUpEmailOTP: createAuthEndpoint(
      "/sign-up/email-otp",
      {
        method: "POST",
        body: z.object({
          name: z.string().trim().min(1).max(100),
          email: z.string().email(),
        }),
      },
      async (ctx) => {
        const { name, email } = ctx.body;
        if (await ctx.context.internalAdapter.findUserByEmail(email)) {
          return ctx.json({ success: true });
        }
        try {
          await ctx.context.internalAdapter.createUser({ email, name, emailVerified: false });
        } catch (err) {
          if (!(await ctx.context.internalAdapter.findUserByEmail(email))) throw err;
        }
        return ctx.json({ success: true });
      },
    ),
  },
} satisfies BetterAuthPlugin;

export async function ensureReviewAccount(): Promise<void> {
  if (config.REVIEW_ACCOUNT_EMAIL === undefined) return;
  await db
    .insert(schema.users)
    .values({
      email: config.REVIEW_ACCOUNT_EMAIL,
      name: "Store Review",
      emailVerified: true,
      role: "guest",
    })
    .onConflictDoNothing({ target: schema.users.email });
}

export const auth = betterAuth({
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  user: {
    modelName: "users",
    additionalFields: {
      role: {
        type: ["guest", "premium", "admin"],
        required: false,
        defaultValue: "guest",
        input: false,
      },
      clerkId: { type: "string", required: false, input: false },
      stravaId: { type: "string", required: false, input: false },
      intervalsAthleteId: { type: "string", required: false, input: false },
      maxHeartRate: { type: "number", required: false, input: false },
      processHeartRate: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      privacyPolicyAcceptedAt: { type: "date", required: false, input: false },
      privacyPolicyVersion: { type: "string", required: false, input: false },
      termsOfServiceAcceptedAt: { type: "date", required: false, input: false },
      termsOfServiceVersion: { type: "string", required: false, input: false },
      lastSeenAt: { type: "date", required: false, input: false },
    },
  },
  session: {
    modelName: "sessions",
    expiresIn: 60 * 60 * 24 * 90,
    updateAge: 60 * 60 * 24,
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: {
    database: { generateId: "uuid" },
    disableOriginCheck: false,
  },
  trustedOrigins: [new URL(config.APP_BASE_URL).origin, "intervalinsights://"],
  rateLimit: {
    customRules: {
      "/sign-in/email-otp": { window: 60, max: 30 },
      "/sign-up/email-otp": { window: 60, max: 30 },
      "/email-otp/send-verification-otp": { window: 60, max: 10 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (user.name) return;
          return { data: { ...user, name: user.email?.split("@")[0] ?? null } };
        },
      },
    },
  },
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return;
        if (isReviewAccountEmail(email)) {
          logger.info({ email }, "review-account OTP issued — email suppressed");
          return;
        }
        await sendSignInOtpEmail(email, otp);
      },
      generateOTP: ({ email, type }) =>
        type === "sign-in" && isReviewAccountEmail(email) ? config.REVIEW_ACCOUNT_OTP : undefined,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      resendStrategy: "reuse",
      storeOTP: "encrypted",
      disableSignUp: true,
    }),
    bearer(),
    expoOriginBridge,
    signUpEmailOtp,
  ],
});
