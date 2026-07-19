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

const fetchClerkIdentity = async (
  c: Context<TGlobalEnv>,
  clerkUserId: string,
): Promise<{ email: string | null; name: string | null }> => {
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
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

export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const baSession = await auth.api.getSession({ headers: c.req.raw.headers });
  if (baSession) {
    const sessionUser = baSession.user as unknown as SelectUser;
    if (sessionUser.banned) {
      return c.json({ error: "Forbidden" }, 403);
    }
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
          c.var.logger.warn({ err, userId: dbUser.id }, "Email enrichment failed — continuing");
        }
      }
    }
    dbUser = await bumpLastSeen(c, dbUser);
  }

  return finishAuth(c, next, dbUser, "clerk");
});
