import { eq } from "drizzle-orm";
import { type InsertUser, type SelectUser, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** Repository for the `users` table. The DAO is the full row. */
export type UserDao = SelectUser;

export function findById(db: Db, userId: string): Promise<UserDao | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

export async function updateById(
  db: Db,
  userId: string,
  updates: Partial<InsertUser>,
): Promise<UserDao | undefined> {
  const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
  return updated;
}

export async function deleteById(db: Db, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}
