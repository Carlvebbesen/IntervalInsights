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

/**
 * App-store reviewers can't read our OTP inbox, so one env-gated demo address
 * accepts a fixed sign-in code every time (all real users keep random emailed
 * OTPs). The code lives ONLY in `REVIEW_ACCOUNT_OTP` — its email is suppressed,
 * so the code never leaves the env. Off by default (both vars unset in prod).
 */
const isReviewAccount = (email: string) =>
  config.REVIEW_ACCOUNT_EMAIL !== undefined && email.toLowerCase() === config.REVIEW_ACCOUNT_EMAIL;

/**
 * Native clients (the Flutter app via `flutter_better_auth`) always carry a
 * persistent session cookie but send no browser `Origin`, so Better Auth's
 * cookie-triggered CSRF check 403s every `/api/auth/*` POST after the first
 * sign-in. The package mimics the Expo protocol and sends `expo-origin`; this
 * bridge promotes it to `origin` so the app scheme (in `trustedOrigins`) passes
 * the check. We do NOT install `@better-auth/expo` — that would drag in its
 * authorization-proxy endpoint and redirect hooks we don't use.
 *
 * Not a CSRF hole: a browser cannot send `expo-origin` cross-site — it's a
 * non-simple header, so it triggers a CORS preflight, and our CORS
 * `allowHeaders` (src/index.ts) does not list it.
 */
const expoOriginBridge = {
  id: "expo-origin-bridge",
  async onRequest(request: Request) {
    if (request.headers.get("origin")) return; // never override a real Origin
    const expoOrigin = request.headers.get("expo-origin");
    if (!expoOrigin) return;
    const headers = new Headers(request.headers);
    headers.set("origin", expoOrigin);
    return { request: new Request(request, { headers }) };
  },
} satisfies BetterAuthPlugin;

/**
 * Explicit sign-up endpoint (replaces the removed OTP auto-register — sign-in
 * with `disableSignUp: true` no longer creates accounts). The client hits this
 * to register, then runs the normal send-verification-otp → sign-in/email-otp
 * round-trip. No session is created here.
 *
 * Enumeration-safe: returns the identical `{ success: true }` whether the email
 * is new (row created) or already registered (nothing created, name ignored),
 * so a caller can never tell which. Rate limiting is free from the `/sign-up`
 * path prefix (Better Auth's built-in rule, production only).
 */
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
          // Unique-violation race: a concurrent request created the row between
          // our check and insert. Re-check; if it now exists, that's success.
          if (!(await ctx.context.internalAdapter.findUserByEmail(email))) throw err;
        }
        return ctx.json({ success: true });
      },
    ),
  },
} satisfies BetterAuthPlugin;

/**
 * Seed the store-review demo account (Item 3 of the sign-in/sign-up split).
 * Removing OTP auto-register means the review address is no longer created on
 * first verify, so we ensure the row exists at boot. Idempotent; a no-op when
 * the env pair is unset. Called explicitly (prod: src/index.ts; tests: the
 * review-account describe) — never as an import-time side effect.
 */
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
  advanced: {
    database: { generateId: "uuid" },
    // Keep the cookie-triggered CSRF origin check ON in every environment.
    // Better Auth defaults `skipOriginCheck` to true under NODE_ENV=test, which
    // would silently disable the check the expo-origin bridge exists to satisfy —
    // pinning it false lets the regression tests exercise the real behaviour.
    // No-op in production (already the default there).
    disableOriginCheck: false,
  },
  // Better Auth matches slash-less origins; APP_BASE_URL may carry a path/slash.
  // `intervalinsights://` is the native app scheme, trusted so the expo-origin
  // bridge above satisfies the CSRF check for cookie-bearing app requests.
  trustedOrigins: [new URL(config.APP_BASE_URL).origin, "intervalinsights://"],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Defensive name fallback for any nameless createUser (our sign-up
          // endpoint always supplies one): default to the email local-part,
          // mirroring the Phase 3 backfill's fallback rule.
          if (user.name) return;
          return { data: { ...user, name: user.email?.split("@")[0] ?? null } };
        },
      },
    },
  },
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Only OTP sign-in is exposed; email-verification / password flows are unused.
        if (type !== "sign-in") return;
        // The review account's code is fixed and known to reviewers — suppress
        // its email so the code never leaves the env.
        if (isReviewAccount(email)) {
          logger.info({ email }, "review-account OTP issued — email suppressed");
          return;
        }
        await sendSignInOtpEmail(email, otp);
      },
      // Return the fixed code for the review account; undefined falls through to
      // the default random generator (verified in the plugin's resolveOTP).
      generateOTP: ({ email, type }) =>
        type === "sign-in" && isReviewAccount(email) ? config.REVIEW_ACCOUNT_OTP : undefined,
      otpLength: 6,
      expiresIn: 600, // 10 minutes, matching the email copy
      allowedAttempts: 5,
      // Resending reuses the outstanding code instead of minting a new one —
      // requires the stored OTP to be recoverable, hence encrypted (not hashed).
      resendStrategy: "reuse",
      storeOTP: "encrypted",
      // Unknown-email sign-in sends no code and creates no account (enumeration
      // protection). Registration goes through the signUpEmailOtp plugin below.
      disableSignUp: true,
    }),
    bearer(),
    expoOriginBridge,
    signUpEmailOtp,
  ],
});
