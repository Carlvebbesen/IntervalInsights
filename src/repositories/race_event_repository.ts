import { and, asc, eq } from "drizzle-orm";
import {
  type InsertRaceEvent,
  type RaceEventStatus,
  raceEvents,
  type SelectRaceEvent,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type RaceEventDao = Omit<SelectRaceEvent, "userId">;

export const raceEventColumns = {
  id: raceEvents.id,
  name: raceEvents.name,
  date: raceEvents.date,
  distanceMeters: raceEvents.distanceMeters,
  targetTimeSeconds: raceEvents.targetTimeSeconds,
  priority: raceEvents.priority,
  status: raceEvents.status,
  createdAt: raceEvents.createdAt,
  updatedAt: raceEvents.updatedAt,
} as const;

export async function listForUser(
  db: Db,
  userId: string,
  filters: { status?: RaceEventStatus } = {},
): Promise<RaceEventDao[]> {
  const where = [eq(raceEvents.userId, userId)];
  if (filters.status) where.push(eq(raceEvents.status, filters.status));

  return db
    .select(raceEventColumns)
    .from(raceEvents)
    .where(and(...where))
    .orderBy(asc(raceEvents.date));
}

export async function findByIdForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<RaceEventDao | undefined> {
  const [row] = await db
    .select(raceEventColumns)
    .from(raceEvents)
    .where(and(eq(raceEvents.id, id), eq(raceEvents.userId, userId)));
  return row;
}

export async function createForUser(
  db: Db,
  userId: string,
  values: Omit<InsertRaceEvent, "userId">,
): Promise<RaceEventDao> {
  const [row] = await db
    .insert(raceEvents)
    .values({ ...values, userId })
    .returning(raceEventColumns);
  return row;
}

export async function updateForUser(
  db: Db,
  userId: string,
  id: number,
  updates: Partial<InsertRaceEvent>,
): Promise<RaceEventDao | undefined> {
  const [updated] = await db
    .update(raceEvents)
    .set(updates)
    .where(and(eq(raceEvents.id, id), eq(raceEvents.userId, userId)))
    .returning(raceEventColumns);
  return updated;
}

export async function deleteForUser(db: Db, userId: string, id: number): Promise<boolean> {
  const deleted = await db
    .delete(raceEvents)
    .where(and(eq(raceEvents.id, id), eq(raceEvents.userId, userId)))
    .returning({ id: raceEvents.id });
  return deleted.length > 0;
}

export async function deleteAllForUser(db: Db, userId: string): Promise<void> {
  await db.delete(raceEvents).where(eq(raceEvents.userId, userId));
}
