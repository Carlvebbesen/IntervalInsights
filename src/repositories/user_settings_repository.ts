import { eq } from "drizzle-orm";
import { type InsertUserSettings, type SelectUserSettings, userSettings } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type UserSettingsDao = SelectUserSettings;

/**
 * Returns the user's settings row, creating it with defaults on first access.
 * Race-safe: a concurrent first call from another request just no-ops on the
 * insert and both reads land on the same row.
 */
export async function getOrCreateUserSettings(db: Db, userId: string): Promise<UserSettingsDao> {
  await db.insert(userSettings).values({ userId }).onConflictDoNothing();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (!row) throw new Error(`user_settings row missing for ${userId} after getOrCreate`);
  return row;
}

export type UpdateUserSettingsInput = Partial<
  Omit<InsertUserSettings, "userId" | "createdAt" | "updatedAt">
>;

/** Upsert-style partial update — works whether or not a row exists yet. */
export async function updateUserSettings(
  db: Db,
  userId: string,
  updates: UpdateUserSettingsInput,
): Promise<UserSettingsDao> {
  const [row] = await db
    .insert(userSettings)
    .values({ userId, ...updates })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...updates, updatedAt: new Date() },
    })
    .returning();
  return row;
}
