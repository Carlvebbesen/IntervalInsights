import { createMiddleware } from "hono/factory";
import { TGlobalEnv } from "../types/IRouters";

type UserRole = 'guest' | 'premium' | 'admin';

export function requireRole(...roles: UserRole[]) {
  return createMiddleware<TGlobalEnv>(async (c, next) => {
    const role = c.get('role');
    if (!roles.includes(role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  });
}
