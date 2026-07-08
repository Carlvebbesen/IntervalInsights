import { getAuth } from "@hono/clerk-auth";
import { trace } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { auth } from "../auth";
import * as userRepo from "../repositories/user_repository";
import { type SelectUser, users } from "../schema";
import { clerkClient } from "../services/clerk_client";
import type { IGlobalVariables, TGlobalEnv } from "../types/IRouters";

type AuthProvider = "better-auth" | "clerk";
type AuthIdentity = Pick<IGlobalVariables, "userId" | "clerkUserId" | "role">;

const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

const tagSpanWithUser = ({ userId, clerkUserId, role }: AuthIdentity, provider: AuthProvider) => {
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", userId);
  if (clerkUserId) span?.setAttribute("clerk.user.id", clerkUserId);
  span?.setAttribute("user.role", role);
  // Tracks the Clerk → Better Auth traffic shift; drives the Phase 6 cutover call.
  span?.setAttribute("auth.provider", provider);
};

const bumpLastSeen = async (c: Context<TGlobalEnv>, dbUser: SelectUser): Promise<SelectUser> => {
  if (dbUser.lastSeenAt && Date.now() - dbUser.lastSeenAt.getTime() <= LAST_SEEN_THROTTLE_MS) {
    return dbUser;
  }
  return (await userRepo.updateById(c.env.db, dbUser.id, { lastSeenAt: new Date() })) ?? dbUser;
};

const finishAuth = async (
  c: Context<TGlobalEnv>,
  next: () => Promise<void>,
  dbUser: SelectUser,
  provider: AuthProvider,
) => {
  const identity: AuthIdentity = {
    userId: dbUser.id,
    clerkUserId: dbUser.clerkId,
    role: dbUser.role ?? "guest",
  };
  c.set("clerkUserId", identity.clerkUserId);
  c.set("userId", identity.userId);
  c.set("role", identity.role);
  c.set("user", dbUser);
  tagSpanWithUser(identity, provider);
  c.set("logger", c.var.logger.child({ ...identity, authProvider: provider }));
  await next();
};

/**
 * Fetch email + display name from Clerk for the dual-auth identity bridge.
 * Failures degrade to a null identity (the request must not fail because Clerk's
 * management API hiccuped); the Phase 3 backfill re-runs cover any row this
 * leaves email-less.
 */
const fetchClerkIdentity = async (
  c: Context<TGlobalEnv>,
  clerkUserId: string,
): Promise<{ email: string | null; name: string | null }> => {
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    // Only verified addresses may become the Better Auth identity key — an
    // unverified address would let this Clerk account capture someone else's
    // future OTP sign-in (email is the match key, and we stamp emailVerified).
    const isVerified = (a?: { verification?: { status?: string } | null } | null) =>
      a?.verification?.status === "verified";
    const primary = clerkUser.primaryEmailAddress;
    const address = isVerified(primary)
      ? primary
      : (clerkUser.emailAddresses?.find(isVerified) ?? null);
    const email = address?.emailAddress?.toLowerCase() ?? null;
    const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || null;
    return { email, name };
  } catch (err) {
    c.var.logger.warn(
      { err, clerkUserId },
      "Clerk identity fetch failed — continuing without email",
    );
    return { email: null, name: null };
  }
};

/**
 * Dual-auth guard (App Store review window): a Better Auth bearer token and a
 * legacy Clerk session token both resolve to the same `users` row. The Better
 * Auth path is tried first — `session.user` IS the app users row (every app
 * column is an additionalField), so no extra user query is needed. The Clerk
 * fallback keeps the lazy-create, enriched with email/name from Clerk so rows
 * created during the dual window can later be matched by Better Auth email
 * sign-in (the dual-window identity gap).
 */
export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const baSession = await auth.api.getSession({ headers: c.req.raw.headers });
  if (baSession) {
    // Structurally the full users row — see src/auth.ts additionalFields.
    const sessionUser = baSession.user as unknown as SelectUser;
    const dbUser = await bumpLastSeen(c, sessionUser);
    return finishAuth(c, next, dbUser, "better-auth");
  }

  const clerkAuth = getAuth(c);
  if (!clerkAuth?.userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, clerkAuth.userId),
  });

  if (!dbUser) {
    const { email, name } = await fetchClerkIdentity(c, clerkAuth.userId);
    // onConflictDoNothing covers both a concurrent-create race on clerkId and
    // the email already belonging to another row (e.g. deleted account
    // re-registered via Better Auth OTP while an old Clerk session lives on) —
    // an unguarded insert would 500 every request from that session forever.
    const [newUser] = await c.env.db
      .insert(users)
      .values({
        clerkId: clerkAuth.userId,
        email,
        name,
        emailVerified: email != null,
        lastSeenAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    dbUser = newUser;
    if (dbUser) {
      c.var.logger.info({ clerkUserId: clerkAuth.userId }, "Created new user record");
    } else {
      dbUser = await c.env.db.query.users.findFirst({
        where: eq(users.clerkId, clerkAuth.userId),
      });
    }
    if (!dbUser) {
      // The conflict was on email, not clerkId: create the row without the
      // email; the pre-cutover duplicate-email sanity check reconciles it.
      c.var.logger.warn(
        { clerkUserId: clerkAuth.userId, email },
        "Email already owned by another user — creating row without email",
      );
      const [emailless] = await c.env.db
        .insert(users)
        .values({ clerkId: clerkAuth.userId, name, lastSeenAt: new Date() })
        .onConflictDoNothing()
        .returning();
      dbUser =
        emailless ??
        (await c.env.db.query.users.findFirst({ where: eq(users.clerkId, clerkAuth.userId) }));
    }
    if (!dbUser) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  } else {
    if (!dbUser.email) {
      const { email, name } = await fetchClerkIdentity(c, clerkAuth.userId);
      if (email) {
        try {
          dbUser =
            (await userRepo.updateById(c.env.db, dbUser.id, {
              email,
              name: dbUser.name ?? name,
              emailVerified: true,
            })) ?? dbUser;
        } catch (err) {
          // Unique-email collision belongs to the pre-cutover sanity check, not here.
          c.var.logger.warn({ err, userId: dbUser.id }, "Email enrichment failed — continuing");
        }
      }
    }
    dbUser = await bumpLastSeen(c, dbUser);
  }

  return finishAuth(c, next, dbUser, "clerk");
});
