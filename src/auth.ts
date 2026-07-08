import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { config } from "./config";
import { db } from "./db";
import * as schema from "./schema";
import { sendSignInOtpEmail } from "./services/auth_email";

/**
 * Better Auth instance (dual-auth window: runs alongside Clerk until Phase 6).
 *
 * The `user` model IS the existing `users` table — every app column is declared
 * as an additionalField so `session.user` is structurally the full row and
 * `authGuard` can set it on the context without a re-fetch. IDs stay UUIDs
 * (`generateId: "uuid"`) to match the existing `uuid` primary keys.
 */
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
    expiresIn: 60 * 60 * 24 * 30, // 30 days — mobile users stay signed in
    updateAge: 60 * 60 * 24, // sliding expiry, refreshed at most daily
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: { database: { generateId: "uuid" } },
  trustedOrigins: [config.APP_BASE_URL],
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Only OTP sign-in is exposed; email-verification / password flows are unused.
        if (type !== "sign-in") return;
        await sendSignInOtpEmail(email, otp);
      },
      otpLength: 6,
      expiresIn: 600, // 10 minutes, matching the email copy
      allowedAttempts: 5,
      // Resending reuses the outstanding code instead of minting a new one —
      // requires the stored OTP to be recoverable, hence encrypted (not hashed).
      resendStrategy: "reuse",
      storeOTP: "encrypted",
    }),
    bearer(),
  ],
});
