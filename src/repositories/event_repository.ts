import { and, count, desc, eq } from "drizzle-orm";
import {
  activityEvents,
  type EventStatus,
  type EventType,
  events,
  type InsertEvent,
  type SelectEvent,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/**
 * DAO returned by this repository — the database shape of an event minus the
 * internal `userId`. Controllers map this to a DTO before returning it.
 */
export type EventDao = Omit<SelectEvent, "userId">;

/**
 * Repository for the event aggregate — `events` plus its `activity_events` links
 * (and, in future, `event_attributes`). All DB access for these tables goes
 * through here; controllers never touch the tables directly.
 */

// Columns returned to callers — never leaks internal-only fields.
export const eventColumns = {
  id: events.id,
  eventType: events.eventType,
  bodyLocation: events.bodyLocation,
  description: events.description,
  startTime: events.startTime,
  lastOccurrence: events.lastOccurrence,
  status: events.status,
  resolvedAt: events.resolvedAt,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
} as const;

// Projection for events shown inline on an activity (no created/updated timestamps).
const activityEventColumns = {
  id: events.id,
  eventType: events.eventType,
  bodyLocation: events.bodyLocation,
  description: events.description,
  startTime: events.startTime,
  lastOccurrence: events.lastOccurrence,
  status: events.status,
  resolvedAt: events.resolvedAt,
} as const;

export type ActivityEventDao = Pick<
  SelectEvent,
  | "id"
  | "eventType"
  | "bodyLocation"
  | "description"
  | "startTime"
  | "lastOccurrence"
  | "status"
  | "resolvedAt"
>;

/** Events linked to a given activity, for inline display on the activity detail. */
export function listForActivity(db: Db, activityId: number): Promise<ActivityEventDao[]> {
  return db
    .select(activityEventColumns)
    .from(activityEvents)
    .innerJoin(events, eq(events.id, activityEvents.eventId))
    .where(eq(activityEvents.activityId, activityId));
}

export async function listForUser(
  db: Db,
  userId: string,
  filters: { status?: EventStatus; eventType?: EventType } = {},
) {
  const where = [eq(events.userId, userId)];
  if (filters.status) where.push(eq(events.status, filters.status));
  if (filters.eventType) where.push(eq(events.eventType, filters.eventType));

  return db
    .select(eventColumns)
    .from(events)
    .where(and(...where))
    .orderBy(desc(events.lastOccurrence));
}

/** Insert an event and link it to an activity, atomically. Returns the new row. */
export async function createLinkedToActivity(db: Db, values: InsertEvent, activityId: number) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(events).values(values).returning(eventColumns);
    await tx.insert(activityEvents).values({ activityId, eventId: row.id }).onConflictDoNothing();
    return row;
  });
}

/** Update an event the user owns. Returns the updated row, or `undefined` if not found. */
export async function updateForUser(
  db: Db,
  userId: string,
  id: number,
  updates: Partial<InsertEvent>,
) {
  const [updated] = await db
    .update(events)
    .set(updates)
    .where(and(eq(events.id, id), eq(events.userId, userId)))
    .returning(eventColumns);
  return updated;
}

/**
 * Unlink an event from one activity. If that was the event's last link, the event
 * itself is deleted. Returns `found: false` when the event doesn't belong to the user.
 */
export async function unlinkFromActivity(db: Db, userId: string, id: number, activityId: number) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, id), eq(events.userId, userId)));

    if (!event) return { found: false as const, unlinked: false, deleted: false };

    const unlinked = await tx
      .delete(activityEvents)
      .where(and(eq(activityEvents.eventId, id), eq(activityEvents.activityId, activityId)))
      .returning({ eventId: activityEvents.eventId });

    const [{ remaining }] = await tx
      .select({ remaining: count() })
      .from(activityEvents)
      .where(eq(activityEvents.eventId, id));

    let deleted = false;
    if (remaining === 0) {
      await tx.delete(events).where(eq(events.id, id));
      deleted = true;
    }

    return { found: true as const, unlinked: unlinked.length > 0, deleted };
  });
}
