import { createMiddleware } from "hono/factory";
import { getAuth } from "@hono/clerk-auth";
import { createClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { TGlobalEnv } from "../types/IRouters";
import { users } from "../schema";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const auth = getAuth(c);

  if (!auth?.userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const metadata = auth.sessionClaims?.metadata as { user_id?: string } | undefined;
  if (metadata?.user_id) {
    c.set('clerkUserId', auth.userId);
    c.set('userId', metadata.user_id);
    return next();
  }
  
  console.log(`Cache miss for user ${auth.userId}. Fetching from DB...`);
  
  const dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, auth.userId),
    columns: { id: true }
  });
  
  if (!dbUser) {
    return c.json({ error: 'User profile not found' }, 404);
  }
  await clerkClient.users.updateUserMetadata(auth.userId, {
    publicMetadata: {
      userId: dbUser.id
    }
    }).catch(err => console.error("Failed to sync Clerk metadata", err))
  c.set('clerkUserId', auth.userId);
  c.set('userId', dbUser.id);
  await next();
});