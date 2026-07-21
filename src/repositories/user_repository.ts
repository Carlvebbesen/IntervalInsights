import { and, count, desc, eq, gte, ilike, isNotNull, ne, or, type SQL, sql } from "drizzle-orm";
import { type InsertUser, type SelectUser, users } from "../schema";
import type { UserRole } from "../schema/enums";
import { REVIEW_STRAVA_ID } from "../services/review_account";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type UserDao = SelectUser;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface UserStats {
  totalUsers: number;
  activeToday: number;
  activeThisWeek: number;
  activeThisMonth: number;
  newToday: number;
  newThisWeek: number;
  bannedCount: number;
  stravaConnected: number;
  intervalsConnected: number;
  roleBreakdown: { guest: number; premium: number; admin: number };
}

const countWhere = (cond: SQL) => sql<number>`count(*) filter (where ${cond})`.mapWith(Number);

export async function getUserStats(db: Db): Promise<UserStats> {
  const now = Date.now();
  const dayAgo = new Date(now - MS_PER_DAY);
  const weekAgo = new Date(now - 7 * MS_PER_DAY);
  const monthAgo = new Date(now - 30 * MS_PER_DAY);

  const [row] = await db
    .select({
      totalUsers: count(),
      activeToday: countWhere(gte(users.lastSeenAt, dayAgo)),
      activeThisWeek: countWhere(gte(users.lastSeenAt, weekAgo)),
      activeThisMonth: countWhere(gte(users.lastSeenAt, monthAgo)),
      newToday: countWhere(gte(users.createdAt, dayAgo)),
      newThisWeek: countWhere(gte(users.createdAt, weekAgo)),
      bannedCount: countWhere(eq(users.banned, true)),
      // `<> '0'` also drops NULLs (SQL three-valued logic), so this counts real
      // Strava links only — excluding the store-review demo account's "0" sentinel.
      stravaConnected: countWhere(ne(users.stravaId, REVIEW_STRAVA_ID)),
      intervalsConnected: countWhere(isNotNull(users.intervalsAthleteId)),
      guest: countWhere(eq(users.role, "guest")),
      premium: countWhere(eq(users.role, "premium")),
      admin: countWhere(eq(users.role, "admin")),
    })
    .from(users);

  return {
    totalUsers: row?.totalUsers ?? 0,
    activeToday: row?.activeToday ?? 0,
    activeThisWeek: row?.activeThisWeek ?? 0,
    activeThisMonth: row?.activeThisMonth ?? 0,
    newToday: row?.newToday ?? 0,
    newThisWeek: row?.newThisWeek ?? 0,
    bannedCount: row?.bannedCount ?? 0,
    stravaConnected: row?.stravaConnected ?? 0,
    intervalsConnected: row?.intervalsConnected ?? 0,
    roleBreakdown: {
      guest: row?.guest ?? 0,
      premium: row?.premium ?? 0,
      admin: row?.admin ?? 0,
    },
  };
}

export interface ListUsersParams {
  q?: string;
  role?: UserRole;
  banned?: boolean;
  page: number;
  pageSize: number;
}

export interface ListUsersResult {
  data: UserDao[];
  meta: { page: number; pageSize: number; total: number };
}

export async function listUsers(db: Db, params: ListUsersParams): Promise<ListUsersResult> {
  const { q, role, banned, page, pageSize } = params;
  const conds: SQL[] = [];
  if (q) {
    const like = `%${q}%`;
    const match = or(ilike(users.email, like), ilike(users.name, like));
    if (match) conds.push(match);
  }
  if (role) conds.push(eq(users.role, role));
  if (banned !== undefined) conds.push(eq(users.banned, banned));
  const where = conds.length ? and(...conds) : undefined;

  const [totals] = await db.select({ total: count() }).from(users).where(where);
  const data = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { data, meta: { page, pageSize, total: totals?.total ?? 0 } };
}

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
