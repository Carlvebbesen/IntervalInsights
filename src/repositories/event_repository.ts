import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  activities,
  activityEvents,
  type EventStatus,
  type EventType,
  eventNotes,
  events,
  type InsertEvent,
  type NoteSource,
  type SelectEvent,
  type SelectEventNote,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type EventDao = Omit<SelectEvent, "userId">;

export const eventColumns = {
  id: events.id,
  eventType: events.eventType,
  bodyLocation: events.bodyLocation,
  startTime: events.startTime,
  lastOccurrence: events.lastOccurrence,
  status: events.status,
  resolvedAt: events.resolvedAt,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
} as const;

export type ActivityEventDao = Pick<
  SelectEvent,
  "id" | "eventType" | "bodyLocation" | "startTime" | "lastOccurrence" | "status" | "resolvedAt"
> & { anchorNote: SelectEventNote | null };

const activityEventColumns = {
  id: events.id,
  eventType: events.eventType,
  bodyLocation: events.bodyLocation,
  startTime: events.startTime,
  lastOccurrence: events.lastOccurrence,
  status: events.status,
  resolvedAt: events.resolvedAt,
  anchorNote: eventNotes,
};

export function listForActivity(db: Db, activityId: number): Promise<ActivityEventDao[]> {
  return db
    .select(activityEventColumns)
    .from(activityEvents)
    .innerJoin(events, eq(events.id, activityEvents.eventId))
    .leftJoin(eventNotes, and(eq(eventNotes.eventId, events.id), eq(eventNotes.isAnchor, true)))
    .where(eq(activityEvents.activityId, activityId));
}

/** Link an existing event to an activity. Idempotent through the composite PK,
 * and `lastOccurrence` only ever moves forward (detection's recurrence
 * semantics) — but a manual link writes no note. */
export async function linkToActivity(
  db: Db,
  eventId: number,
  activityId: number,
  activityStart: Date,
): Promise<ActivityEventDao> {
  return db.transaction(async (tx) => {
    await tx.insert(activityEvents).values({ activityId, eventId }).onConflictDoNothing();
    await tx
      .update(events)
      .set({
        updatedAt: new Date(),
        lastOccurrence: sql`GREATEST(${events.lastOccurrence}, ${activityStart})`,
      })
      .where(eq(events.id, eventId));
    const [row] = await tx
      .select(activityEventColumns)
      .from(events)
      .leftJoin(eventNotes, and(eq(eventNotes.eventId, events.id), eq(eventNotes.isAnchor, true)))
      .where(eq(events.id, eventId));
    return row;
  });
}

export async function listForUser(
  db: Db,
  userId: string,
  filters: { status?: EventStatus; eventType?: EventType } = {},
): Promise<EventDao[]> {
  const where = [eq(events.userId, userId)];
  if (filters.status) where.push(eq(events.status, filters.status));
  if (filters.eventType) where.push(eq(events.eventType, filters.eventType));

  return db
    .select(eventColumns)
    .from(events)
    .where(and(...where))
    .orderBy(desc(events.lastOccurrence));
}

export async function getForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<EventDao | undefined> {
  const [row] = await db
    .select(eventColumns)
    .from(events)
    .where(and(eq(events.id, id), eq(events.userId, userId)));
  return row;
}

export type LinkedActivityRow = {
  id: number;
  name: string;
  startDateLocal: Date;
  sportType: string;
};

export function listLinkedActivities(db: Db, eventId: number): Promise<LinkedActivityRow[]> {
  return db
    .select({
      id: activities.id,
      name: activities.title,
      startDateLocal: activities.startDateLocal,
      sportType: activities.sportType,
    })
    .from(activityEvents)
    .innerJoin(activities, eq(activities.id, activityEvents.activityId))
    .where(eq(activityEvents.eventId, eventId))
    .orderBy(desc(activities.startDateLocal));
}

/** Create an event, optionally link it to an activity, and write its anchor note
 * — all in one transaction (D2/D3: the anchor is the event's canonical summary). */
export async function createEventWithAnchor(
  db: Db,
  values: InsertEvent,
  anchor: { note: string; source: NoteSource; occurredAt: Date },
  activityId?: number,
): Promise<{ event: EventDao; anchorNote: SelectEventNote }> {
  return db.transaction(async (tx) => {
    const [event] = await tx.insert(events).values(values).returning(eventColumns);
    if (activityId !== undefined) {
      await tx
        .insert(activityEvents)
        .values({ activityId, eventId: event.id })
        .onConflictDoNothing();
    }
    const [anchorNote] = await tx
      .insert(eventNotes)
      .values({
        eventId: event.id,
        userId: values.userId,
        note: anchor.note,
        source: anchor.source,
        occurredAt: anchor.occurredAt,
        isAnchor: true,
      })
      .returning();
    return { event, anchorNote };
  });
}

export async function updateForUser(
  db: Db,
  userId: string,
  id: number,
  updates: Partial<InsertEvent>,
): Promise<EventDao | undefined> {
  const [updated] = await db
    .update(events)
    .set(updates)
    .where(and(eq(events.id, id), eq(events.userId, userId)))
    .returning(eventColumns);
  return updated;
}

/** Delete an event outright (cascades notes, links, attributes). Used by the
 * standalone DELETE /:id (no activityId) path. */
export async function deleteForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<{ found: boolean; deleted: boolean }> {
  const deleted = await db
    .delete(events)
    .where(and(eq(events.id, id), eq(events.userId, userId)))
    .returning({ id: events.id });
  return { found: deleted.length > 0, deleted: deleted.length > 0 };
}

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
