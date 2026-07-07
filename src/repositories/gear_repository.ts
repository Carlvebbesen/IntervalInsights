import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { AppError } from "../error";
import {
  activities,
  type GearSurface,
  type GearType,
  gearDefaults,
  gearSignatureDefaults,
  gears,
  type InsertGear,
  type SelectGear,
  type TrainingBucket,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/** DAO returned by this repository — the full gear row minus the internal `userId`. */
export type GearDao = Omit<SelectGear, "userId">;

// Columns returned to callers — never leaks `userId`.
export const gearColumns = {
  id: gears.id,
  gearType: gears.gearType,
  brand: gears.brand,
  model: gears.model,
  nickname: gears.nickname,
  surface: gears.surface,
  useTypes: gears.useTypes,
  isActive: gears.isActive,
  retiredAt: gears.retiredAt,
  stravaGearId: gears.stravaGearId,
  baselineDistanceMeters: gears.baselineDistanceMeters,
  baselineDate: gears.baselineDate,
  maintainedDistanceMeters: gears.maintainedDistanceMeters,
  activityCount: gears.activityCount,
  createdAt: gears.createdAt,
} as const;

// Compact projection for resolving a gear name/badge on an activity.
export const gearSummaryColumns = {
  id: gears.id,
  brand: gears.brand,
  model: gears.model,
  nickname: gears.nickname,
  surface: gears.surface,
  isActive: gears.isActive,
} as const;

export type GearSummaryDao = {
  id: number;
  brand: string | null;
  model: string;
  nickname: string | null;
  surface: GearSurface;
  isActive: boolean;
};

export interface GearListFilters {
  surface?: GearSurface;
  gearType?: GearType;
  includeRetired?: boolean;
  sortBy?: "distance" | "created" | "name";
  order?: "asc" | "desc";
}

/** An assigned activity contributes its distance to a gear's maintained total iff
 * the gear has no baseline (manual) or the activity is dated after it. Compared in
 * JS (both are Date instances) to avoid timestamp-param coercion across the driver. */
function contributes(baselineDate: Date | null, startDateLocal: Date): boolean {
  return baselineDate === null || startDateLocal > baselineDate;
}

export function listForUser(db: Db, userId: string, f: GearListFilters = {}): Promise<GearDao[]> {
  const where = [eq(gears.userId, userId)];
  if (f.gearType) where.push(eq(gears.gearType, f.gearType));
  if (f.surface) where.push(eq(gears.surface, f.surface));
  if (!f.includeRetired) where.push(eq(gears.isActive, true));

  const dir = f.order === "asc" ? asc : desc;
  const distanceExpr = sql`${gears.baselineDistanceMeters} + ${gears.maintainedDistanceMeters}`;
  const sortCol =
    f.sortBy === "created"
      ? gears.createdAt
      : f.sortBy === "name"
        ? sql`lower(coalesce(${gears.brand} || ' ', '') || ${gears.model})`
        : distanceExpr;

  return db
    .select(gearColumns)
    .from(gears)
    .where(and(...where))
    .orderBy(dir(sortCol));
}

export async function findByIdForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<GearDao | undefined> {
  const [row] = await db
    .select(gearColumns)
    .from(gears)
    .where(and(eq(gears.id, id), eq(gears.userId, userId)));
  return row;
}

export async function findByStravaGearId(
  db: Db,
  userId: string,
  stravaGearId: string,
): Promise<GearDao | undefined> {
  const [row] = await db
    .select(gearColumns)
    .from(gears)
    .where(and(eq(gears.userId, userId), eq(gears.stravaGearId, stravaGearId)));
  return row;
}

export async function findSummariesByIds(
  db: Db,
  userId: string,
  ids: number[],
): Promise<Map<number, GearSummaryDao>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select(gearSummaryColumns)
    .from(gears)
    .where(and(eq(gears.userId, userId), inArray(gears.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function create(
  db: Db,
  userId: string,
  values: Omit<InsertGear, "userId">,
): Promise<GearDao> {
  const [row] = await db
    .insert(gears)
    .values({ ...values, userId })
    .returning(gearColumns);
  return row;
}

export async function update(
  db: Db,
  userId: string,
  id: number,
  updates: Partial<InsertGear>,
): Promise<GearDao | undefined> {
  const [row] = await db
    .update(gears)
    .set(updates)
    .where(and(eq(gears.id, id), eq(gears.userId, userId)))
    .returning(gearColumns);
  return row;
}

// ─── Defaults (one gear per (bucket, surface) per user) ─────────────────────────

export function getDefaults(db: Db, userId: string) {
  return db
    .select({
      bucket: gearDefaults.bucket,
      surface: gearDefaults.surface,
      gearId: gearDefaults.gearId,
    })
    .from(gearDefaults)
    .where(eq(gearDefaults.userId, userId));
}

export async function findDefaultGearId(
  db: Db,
  userId: string,
  bucket: TrainingBucket,
  surface: GearSurface,
): Promise<number | undefined> {
  const [row] = await db
    .select({ gearId: gearDefaults.gearId })
    .from(gearDefaults)
    .where(
      and(
        eq(gearDefaults.userId, userId),
        eq(gearDefaults.bucket, bucket),
        eq(gearDefaults.surface, surface),
      ),
    );
  return row?.gearId;
}

export async function setDefault(
  db: Db,
  userId: string,
  bucket: TrainingBucket,
  surface: GearSurface,
  gearId: number,
): Promise<void> {
  await db
    .insert(gearDefaults)
    .values({ userId, bucket, surface, gearId })
    .onConflictDoUpdate({
      target: [gearDefaults.userId, gearDefaults.bucket, gearDefaults.surface],
      set: { gearId },
    });
}

export async function clearDefault(
  db: Db,
  userId: string,
  bucket: TrainingBucket,
  surface: GearSurface,
): Promise<void> {
  await db
    .delete(gearDefaults)
    .where(
      and(
        eq(gearDefaults.userId, userId),
        eq(gearDefaults.bucket, bucket),
        eq(gearDefaults.surface, surface),
      ),
    );
}

export async function clearDefaultsForGear(db: Db, userId: string, gearId: number): Promise<void> {
  await db
    .delete(gearDefaults)
    .where(and(eq(gearDefaults.userId, userId), eq(gearDefaults.gearId, gearId)));
}

// ─── Per-signature defaults (one gear per (user, interval structure)) ───────────

export function getSignatureDefaults(db: Db, userId: string) {
  return db
    .select({
      intervalStructureId: gearSignatureDefaults.intervalStructureId,
      gearId: gearSignatureDefaults.gearId,
    })
    .from(gearSignatureDefaults)
    .where(eq(gearSignatureDefaults.userId, userId));
}

export async function findSignatureDefaultGearId(
  db: Db,
  userId: string,
  intervalStructureId: number,
): Promise<number | undefined> {
  const [row] = await db
    .select({ gearId: gearSignatureDefaults.gearId })
    .from(gearSignatureDefaults)
    .where(
      and(
        eq(gearSignatureDefaults.userId, userId),
        eq(gearSignatureDefaults.intervalStructureId, intervalStructureId),
      ),
    );
  return row?.gearId;
}

export async function setSignatureDefault(
  db: Db,
  userId: string,
  intervalStructureId: number,
  gearId: number,
): Promise<void> {
  await db
    .insert(gearSignatureDefaults)
    .values({ userId, intervalStructureId, gearId })
    .onConflictDoUpdate({
      target: [gearSignatureDefaults.userId, gearSignatureDefaults.intervalStructureId],
      set: { gearId },
    });
}

export async function clearSignatureDefault(
  db: Db,
  userId: string,
  intervalStructureId: number,
): Promise<void> {
  await db
    .delete(gearSignatureDefaults)
    .where(
      and(
        eq(gearSignatureDefaults.userId, userId),
        eq(gearSignatureDefaults.intervalStructureId, intervalStructureId),
      ),
    );
}

export async function clearSignatureDefaultsForGear(
  db: Db,
  userId: string,
  gearId: number,
): Promise<void> {
  await db
    .delete(gearSignatureDefaults)
    .where(and(eq(gearSignatureDefaults.userId, userId), eq(gearSignatureDefaults.gearId, gearId)));
}

// ─── Denormalized distance/count maintenance ────────────────────────────────────

/**
 * Move an activity onto `newGearId` (or off all gear when null), keeping both the
 * old and new gear's `activityCount` + `maintainedDistanceMeters` correct. Atomic.
 */
export async function assignActivityToGear(
  db: Db,
  userId: string,
  activityId: number,
  newGearId: number | null,
): Promise<{
  found: boolean;
  changed: boolean;
  oldGearId: number | null;
  newGearId: number | null;
}> {
  return db.transaction(async (tx) => {
    const [act] = await tx
      .select({
        localGearId: activities.localGearId,
        distance: activities.distance,
        startDateLocal: activities.startDateLocal,
      })
      .from(activities)
      .where(and(eq(activities.id, activityId), eq(activities.userId, userId)));
    if (!act) return { found: false, changed: false, oldGearId: null, newGearId: null };

    const oldGearId = act.localGearId;
    if (oldGearId === newGearId) {
      return { found: true, changed: false, oldGearId, newGearId };
    }

    let newBaselineDate: Date | null = null;
    if (newGearId !== null) {
      const [g] = await tx
        .select({ baselineDate: gears.baselineDate })
        .from(gears)
        .where(and(eq(gears.id, newGearId), eq(gears.userId, userId)));
      if (!g) throw new AppError(404, "Gear not found");
      newBaselineDate = g.baselineDate;
    }

    await tx
      .update(activities)
      .set({ localGearId: newGearId })
      .where(and(eq(activities.id, activityId), eq(activities.userId, userId)));

    if (oldGearId !== null) {
      const [og] = await tx
        .select({ baselineDate: gears.baselineDate })
        .from(gears)
        .where(eq(gears.id, oldGearId));
      const amount = og && contributes(og.baselineDate, act.startDateLocal) ? act.distance : 0;
      await tx
        .update(gears)
        .set({
          activityCount: sql`GREATEST(0, ${gears.activityCount} - 1)`,
          maintainedDistanceMeters: sql`GREATEST(0::double precision, ${gears.maintainedDistanceMeters} - ${amount})`,
        })
        .where(eq(gears.id, oldGearId));
    }

    if (newGearId !== null) {
      const amount = contributes(newBaselineDate, act.startDateLocal) ? act.distance : 0;
      await tx
        .update(gears)
        .set({
          activityCount: sql`${gears.activityCount} + 1`,
          maintainedDistanceMeters: sql`${gears.maintainedDistanceMeters} + ${amount}`,
        })
        .where(eq(gears.id, newGearId));
    }

    return { found: true, changed: true, oldGearId, newGearId };
  });
}

/** Apply a distance delta to an activity's gear after a Strava `update` webhook. */
export async function adjustForDistanceChange(
  db: Db,
  activityId: number,
  oldDistance: number,
  newDistance: number,
): Promise<void> {
  if (oldDistance === newDistance) return;
  await db.transaction(async (tx) => {
    const [act] = await tx
      .select({ localGearId: activities.localGearId, startDateLocal: activities.startDateLocal })
      .from(activities)
      .where(eq(activities.id, activityId));
    if (!act || act.localGearId === null) return;
    const [g] = await tx
      .select({ baselineDate: gears.baselineDate })
      .from(gears)
      .where(eq(gears.id, act.localGearId));
    if (!g || !contributes(g.baselineDate, act.startDateLocal)) return;
    const delta = newDistance - oldDistance;
    await tx
      .update(gears)
      .set({
        maintainedDistanceMeters: sql`GREATEST(0::double precision, ${gears.maintainedDistanceMeters} + ${delta})`,
      })
      .where(eq(gears.id, act.localGearId));
  });
}

/** Recompute `activityCount` + `maintainedDistanceMeters` from scratch (reconciliation). */
export async function recompute(db: Db, gearId: number): Promise<void> {
  const [agg] = await db
    .select({
      cnt: count(),
      maint: sql<number>`COALESCE(SUM(CASE WHEN ${gears.baselineDate} IS NULL OR ${activities.startDateLocal} > ${gears.baselineDate} THEN ${activities.distance} ELSE 0 END), 0)`,
    })
    .from(activities)
    .innerJoin(gears, eq(gears.id, activities.localGearId))
    .where(eq(activities.localGearId, gearId));
  await db
    .update(gears)
    .set({
      activityCount: Number(agg?.cnt ?? 0),
      maintainedDistanceMeters: Number(agg?.maint ?? 0),
    })
    .where(eq(gears.id, gearId));
}

/** Re-snapshot a gear's Strava baseline (distance + date=now) then recompute the
 * post-baseline maintained total — the only correct way to refresh from Strava. */
export async function resync(db: Db, gearId: number, stravaDistanceMeters: number): Promise<void> {
  await db
    .update(gears)
    .set({ baselineDistanceMeters: stravaDistanceMeters, baselineDate: new Date() })
    .where(eq(gears.id, gearId));
  await recompute(db, gearId);
}

/** Link every still-unlinked activity carrying `stravaGearId` to a local gear. Returns linked count. */
export async function linkActivitiesByStravaGearId(
  db: Db,
  userId: string,
  stravaGearId: string,
  localGearId: number,
): Promise<number> {
  const linked = await db
    .update(activities)
    .set({ localGearId })
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.gearId, stravaGearId),
        isNotNull(activities.gearId),
      ),
    )
    .returning({ id: activities.id });
  return linked.length;
}

// ─── Suggestions / stats helpers ────────────────────────────────────────────────

/** Active gears most recently used on a surface, most-recent first (for suggestions). */
export async function recentGearIdsBySurface(
  db: Db,
  userId: string,
  surface: GearSurface,
  limit = 3,
): Promise<number[]> {
  const rows = await db
    .select({ gearId: activities.localGearId })
    .from(activities)
    .innerJoin(gears, eq(gears.id, activities.localGearId))
    .where(and(eq(activities.userId, userId), eq(gears.surface, surface), eq(gears.isActive, true)))
    .groupBy(activities.localGearId)
    .orderBy(desc(sql`max(${activities.startDateLocal})`))
    .limit(limit);
  return rows.map((r) => r.gearId).filter((x): x is number => x !== null);
}

/** One row per (gear, trainingType) with a count — for the per-shoe stats chips. */
export function trainingTypeCountsByGear(db: Db, userId: string) {
  return db
    .select({
      gearId: activities.localGearId,
      trainingType: activities.trainingType,
      count: count(),
    })
    .from(activities)
    .where(and(eq(activities.userId, userId), isNotNull(activities.localGearId)))
    .groupBy(activities.localGearId, activities.trainingType);
}
