import { createClerkClient } from "@clerk/backend";
import { getAuth } from "@hono/clerk-auth";
import { trace } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { users } from "../schema";
import type { IGlobalVariables, TGlobalEnv } from "../types/IRouters";

type AuthIdentity = Pick<IGlobalVariables, "userId" | "clerkUserId" | "role">;

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

  const metadata = auth.sessionClaims?.metadata as
    | { user_id?: string; role?: "guest" | "premium" | "admin" }
    | undefined;
  if (metadata?.user_id && metadata?.role) {
    const identity: AuthIdentity = {
      userId: metadata.user_id,
      clerkUserId: auth.userId,
      role: metadata.role,
    };
    c.set("clerkUserId", identity.clerkUserId);
    c.set("userId", identity.userId);
    c.set("role", identity.role);
    tagSpanWithUser(identity);
    attachIdentityLogger(c, identity);
    return next();
  }

  c.var.logger.info({ clerkUserId: auth.userId }, "Cache miss for user — syncing with DB");

  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, auth.userId),
  });

  if (!dbUser) {
    const [newUser] = await c.env.db
      .insert(users)
      .values({
        clerkId: auth.userId,
      })
      .returning();

    dbUser = newUser;
    c.var.logger.info({ clerkUserId: auth.userId }, "Created new user record");
  }

  try {
    await clerkClient.users.updateUserMetadata(auth.userId, {
      publicMetadata: {
        user_id: dbUser.id,
        role: dbUser.role,
      },
    });
  } catch (err) {
    c.var.logger.error({ err }, "Failed to sync Clerk metadata");
  }

  const role = dbUser.role ?? "guest";
  const identity: AuthIdentity = { userId: dbUser.id, clerkUserId: auth.userId, role };
  c.set("clerkUserId", identity.clerkUserId);
  c.set("userId", identity.userId);
  c.set("role", identity.role);
  tagSpanWithUser(identity);
  attachIdentityLogger(c, identity);

  await next();
});
