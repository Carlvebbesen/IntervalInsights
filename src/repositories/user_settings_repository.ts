import { eq } from "drizzle-orm";
import { type InsertUserSettings, type SelectUserSettings, userSettings, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type UserSettingsDao = SelectUserSettings;

/**
 * Returns the user's settings row, creating it on first access. Steady state
 * is a single SELECT; the seed path (read `users` HR columns → seeded insert
 * → re-select) only runs on a miss. Seeding backfills `maxHeartRate`/
 * `processHeartRate` from the legacy `users` columns — pure defaults would
 * permanently drop an existing user's HR settings, since the backfill is
 * onConflictDoNothing and never repairs an existing row. Race-safe: concurrent
 * misses insert identical seeded values, so the losing onConflictDoNothing
 * changes nothing.
 * Returns null (never throws) when the `users` row itself is missing — e.g. a
 * webhook racing an account deletion. Callers that need the missing-row case
 * to be a hard invariant break should use `getOrCreateUserSettings` instead.
 */
export async function findOrCreateUserSettings(
  db: Db,
  userId: string,
): Promise<UserSettingsDao | null> {
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) return existing;

  const user = await db.query.users.findFirst({
    columns: { maxHeartRate: true, processHeartRate: true },
    where: eq(users.id, userId),
  });
  if (!user) return null;
  await db
    .insert(userSettings)
    .values({ userId, maxHeartRate: user.maxHeartRate, processHeartRate: user.processHeartRate })
    .onConflictDoNothing();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  return row ?? null;
}

/** Throwing wrapper around `findOrCreateUserSettings` for authenticated paths
 * where a missing `users` row is a real invariant break, not a valid state. */
export async function getOrCreateUserSettings(db: Db, userId: string): Promise<UserSettingsDao> {
  const row = await findOrCreateUserSettings(db, userId);
  if (!row) throw new Error(`user ${userId} not found in getOrCreateUserSettings`);
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
