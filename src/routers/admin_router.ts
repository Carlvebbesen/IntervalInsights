import { Hono } from "hono";
import { TGlobalEnv } from "../types/IRouters";
import { requireRole } from "../middlewares/role_middleware";
import { eq } from "drizzle-orm";
import { users } from "../schema";
import { createClerkClient } from "@clerk/backend";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const adminRouter = new Hono<TGlobalEnv>();

adminRouter.use('*', requireRole('admin'));

const roleSchema = z.object({
  role: z.enum(['guest', 'premium', 'admin']),
});

adminRouter.patch('/users/:id/role', zValidator('json', roleSchema), async (c) => {
  const targetUserId = c.req.param('id');
  const { role } = c.req.valid('json');

  const [updated] = await c.env.db
    .update(users)
    .set({ role })
    .where(eq(users.id, targetUserId))
    .returning();

  if (!updated) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Invalidate Clerk public metadata cache so the new role takes effect on next token refresh
  await clerkClient.users.updateUserMetadata(updated.clerkId, {
    publicMetadata: { userId: updated.id, role },
  });

  return c.json({ id: updated.id, role: updated.role });
});

export default adminRouter;
