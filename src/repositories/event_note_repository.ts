import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { eventNotes, events, type InsertEventNote, type SelectEventNote } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type EventNoteDao = SelectEventNote;

export function listForEvent(db: Db, eventId: number): Promise<SelectEventNote[]> {
  return db
    .select()
    .from(eventNotes)
    .where(eq(eventNotes.eventId, eventId))
    .orderBy(asc(eventNotes.occurredAt), asc(eventNotes.id));
}

export async function getAnchor(db: Db, eventId: number): Promise<SelectEventNote | undefined> {
  const [row] = await db
    .select()
    .from(eventNotes)
    .where(and(eq(eventNotes.eventId, eventId), eq(eventNotes.isAnchor, true)));
  return row;
}

export async function anchorNotesFor(
  db: Db,
  eventIds: number[],
): Promise<Map<number, SelectEventNote>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(eventNotes)
    .where(and(inArray(eventNotes.eventId, eventIds), eq(eventNotes.isAnchor, true)));
  return new Map(rows.map((r) => [r.eventId, r]));
}

export async function latestNotesFor(
  db: Db,
  eventIds: number[],
): Promise<Map<number, SelectEventNote>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([eventNotes.eventId])
    .from(eventNotes)
    .where(inArray(eventNotes.eventId, eventIds))
    .orderBy(eventNotes.eventId, desc(eventNotes.occurredAt), desc(eventNotes.id));
  return new Map(rows.map((r) => [r.eventId, r]));
}

export async function createNote(db: Db, values: InsertEventNote): Promise<SelectEventNote> {
  const [row] = await db.insert(eventNotes).values(values).returning();
  return row;
}

/** Ownership is checked note → event → user. Returns undefined when the note is
 * absent or not owned by `userId`. The anchor note IS editable (Carl's ask). */
export async function updateNoteForUser(
  db: Db,
  userId: string,
  eventId: number,
  noteId: number,
  updates: Partial<InsertEventNote>,
): Promise<SelectEventNote | undefined> {
  const owned = await db
    .select({ id: eventNotes.id })
    .from(eventNotes)
    .innerJoin(events, eq(events.id, eventNotes.eventId))
    .where(
      and(eq(eventNotes.id, noteId), eq(eventNotes.eventId, eventId), eq(events.userId, userId)),
    );
  if (owned.length === 0) return undefined;

  const [updated] = await db
    .update(eventNotes)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(eventNotes.id, noteId))
    .returning();
  return updated;
}

/** Ownership-checked. The anchor note cannot be deleted — it is the event's
 * canonical summary. Returns `{ found:false }` when absent/unauthorized,
 * `{ found:true, isAnchor:true }` when the caller tried to delete the anchor. */
export async function deleteNoteForUser(
  db: Db,
  userId: string,
  eventId: number,
  noteId: number,
): Promise<{ found: boolean; isAnchor: boolean; deleted: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: eventNotes.id, isAnchor: eventNotes.isAnchor })
      .from(eventNotes)
      .innerJoin(events, eq(events.id, eventNotes.eventId))
      .where(
        and(eq(eventNotes.id, noteId), eq(eventNotes.eventId, eventId), eq(events.userId, userId)),
      );
    if (!row) return { found: false, isAnchor: false, deleted: false };
    if (row.isAnchor) return { found: true, isAnchor: true, deleted: false };
    await tx.delete(eventNotes).where(eq(eventNotes.id, noteId));
    return { found: true, isAnchor: false, deleted: true };
  });
}

/** Bump an event's updatedAt (and lastOccurrence when the note is newer). Used
 * after a note write. Never flips status (D4). */
export async function touchEventForNote(db: Db, eventId: number, occurredAt: Date): Promise<void> {
  await db
    .update(events)
    .set({
      updatedAt: new Date(),
      lastOccurrence: sql`GREATEST(${events.lastOccurrence}, ${occurredAt})`,
    })
    .where(eq(events.id, eventId));
}
