import { trace } from "@opentelemetry/api";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { auth } from "../auth";
import * as userRepo from "../repositories/user_repository";
import type { SelectUser } from "../schema";
import type { IGlobalVariables, TGlobalEnv } from "../types/IRouters";

type AuthIdentity = Pick<IGlobalVariables, "userId" | "role">;

const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

const tagSpanWithUser = ({ userId, role }: AuthIdentity) => {
  const span = trace.getActiveSpan();
  span?.setAttribute("user.id", userId);
  span?.setAttribute("user.role", role);
  span?.setAttribute("auth.provider", "better-auth");
};

const bumpLastSeen = async (c: Context<TGlobalEnv>, dbUser: SelectUser): Promise<SelectUser> => {
  if (dbUser.lastSeenAt && Date.now() - dbUser.lastSeenAt.getTime() <= LAST_SEEN_THROTTLE_MS) {
    return dbUser;
  }
  return (await userRepo.updateById(c.env.db, dbUser.id, { lastSeenAt: new Date() })) ?? dbUser;
};

export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const baSession = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!baSession) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sessionUser = baSession.user as unknown as SelectUser;
  if (sessionUser.banned) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const dbUser = await bumpLastSeen(c, sessionUser);
  const identity: AuthIdentity = { userId: dbUser.id, role: dbUser.role ?? "guest" };
  c.set("userId", identity.userId);
  c.set("role", identity.role);
  c.set("user", dbUser);
  tagSpanWithUser(identity);
  c.set("logger", c.var.logger.child({ ...identity, authProvider: "better-auth" }));
  await next();
});
