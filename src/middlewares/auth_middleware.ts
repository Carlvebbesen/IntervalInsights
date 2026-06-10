import { createClerkClient } from "@clerk/backend";
import { getAuth } from "@hono/clerk-auth";
import { trace } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import * as userRepo from "../repositories/user_repository";
import { users } from "../schema";
import type { IGlobalVariables, TGlobalEnv } from "../types/IRouters";

type AuthIdentity = Pick<IGlobalVariables, "userId" | "clerkUserId" | "role">;

const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

const tagSpanWithUser = ({ userId, clerkUserId, role }: AuthIdentity) => {
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", userId);
  span?.setAttribute("clerk.user.id", clerkUserId);
  span?.setAttribute("user.role", role);
};

const attachIdentityLogger = (c: Context<TGlobalEnv>, identity: AuthIdentity) => {
  c.set("logger", c.var.logger.child(identity));
};

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const auth = getAuth(c);

  if (!auth?.userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, auth.userId),
  });

  if (!dbUser) {
    const [newUser] = await c.env.db
      .insert(users)
      .values({ clerkId: auth.userId, lastSeenAt: new Date() })
      .returning();
    dbUser = newUser;
    c.var.logger.info({ clerkUserId: auth.userId }, "Created new user record");
    clerkClient.users
      .updateUserMetadata(auth.userId, {
        publicMetadata: { role: newUser.role ?? "guest" },
      })
      .catch((err) => {
        c.var.logger.error({ err, clerkUserId: auth.userId }, "Failed to sync Clerk metadata");
      });
  } else if (
    !dbUser.lastSeenAt ||
    Date.now() - dbUser.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS
  ) {
    dbUser = (await userRepo.updateById(c.env.db, dbUser.id, { lastSeenAt: new Date() })) ?? dbUser;
  }

  const role = dbUser.role ?? "guest";
  const identity: AuthIdentity = { userId: dbUser.id, clerkUserId: auth.userId, role };
  c.set("clerkUserId", identity.clerkUserId);
  c.set("userId", identity.userId);
  c.set("role", identity.role);
  c.set("user", dbUser);
  tagSpanWithUser(identity);
  attachIdentityLogger(c, identity);

  await next();
});
