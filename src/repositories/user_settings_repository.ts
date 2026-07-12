import { eq } from "drizzle-orm";
import { type InsertUserSettings, type SelectUserSettings, userSettings, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type UserSettingsDao = SelectUserSettings;

/**
 * Returns the user's settings row, creating it on first access. Lazy creation
 * seeds `maxHeartRate`/`processHeartRate` from the legacy `users` columns —
 * pure defaults would permanently drop an existing user's HR settings, since
 * the backfill is onConflictDoNothing and never repairs an existing row.
 * Race-safe: concurrent first calls insert identical seeded values, so the
 * losing onConflictDoNothing changes nothing.
 */
export async function getOrCreateUserSettings(db: Db, userId: string): Promise<UserSettingsDao> {
  const user = await db.query.users.findFirst({
    columns: { maxHeartRate: true, processHeartRate: true },
    where: eq(users.id, userId),
  });
  if (!user) throw new Error(`user ${userId} not found in getOrCreateUserSettings`);
  await db
    .insert(userSettings)
    .values({ userId, maxHeartRate: user.maxHeartRate, processHeartRate: user.processHeartRate })
    .onConflictDoNothing();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (!row) throw new Error(`user_settings row missing for ${userId} after getOrCreate`);
  return row;
}

export type UpdateUserSettingsInput = Partial<
  Omit<InsertUserSettings, "userId" | "createdAt" | "updatedAt">
>;

/** Partial update that works when no row exists yet — the seeded getOrCreate
 * runs first so a first-ever PATCH can't create an unseeded row. */
export async function updateUserSettings(
  db: Db,
  userId: string,
  updates: UpdateUserSettingsInput,
): Promise<UserSettingsDao> {
  await getOrCreateUserSettings(db, userId);
  const [row] = await db
    .update(userSettings)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId))
    .returning();
  return row;
}
