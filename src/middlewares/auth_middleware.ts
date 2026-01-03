import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { TGlobalEnv } from "../types/IRouters";
import { getAuth } from "@hono/clerk-auth";
import { eq } from "drizzle-orm";
import { users } from "../schema";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const authGuard = createMiddleware<TGlobalEnv>(async (c, next) => {
  const auth = getAuth(c);

  if (!auth?.userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const metadata = auth.sessionClaims?.metadata as { userId?: string } | undefined;
  if (metadata?.userId) {
    c.set('clerkUserId', auth.userId);
    c.set('userId', metadata.userId);
    return next();
  }
  
  console.log(`Cache miss for user ${auth.userId}. Syncing with DB...`);
  
  let dbUser = await c.env.db.query.users.findFirst({
    where: eq(users.clerkId, auth.userId),
  });

  if (!dbUser) {
    const [newUser] = await c.env.db.insert(users).values({
        clerkId: auth.userId,
      }).returning();
    
    dbUser = newUser;
    console.log(`Created new user record for Clerk User: ${auth.userId}`);
  }

  clerkClient.users.updateUserMetadata(auth.userId, {
    publicMetadata: {
      userId: dbUser.id
    }
  }).catch(err => console.error("Failed to sync Clerk metadata", err));

  c.set('clerkUserId', auth.userId);
  c.set('userId', dbUser.id);
  
  await next();
});