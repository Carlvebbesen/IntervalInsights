import {
  type ActivityEventDto,
  type DeleteEventDto,
  type EventDetailDto,
  type EventDto,
  type EventNoteDto,
  toActivityEventDto,
  toEventDetailDto,
  toEventDto,
  toEventNoteDto,
} from "../dtos/event_dto";
import { AppError } from "../error";
import * as activityRepo from "../repositories/activity_repository";
import * as noteRepo from "../repositories/event_note_repository";
import type { EventDao } from "../repositories/event_repository";
import * as eventRepo from "../repositories/event_repository";
import type { EventStatus, EventType, InsertEvent, InsertEventNote, NoteTrend } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

async function hydrateEvent(db: Db, event: EventDao): Promise<EventDto> {
  const [anchors, latests] = await Promise.all([
    noteRepo.anchorNotesFor(db, [event.id]),
    noteRepo.latestNotesFor(db, [event.id]),
  ]);
  return toEventDto(event, anchors.get(event.id) ?? null, latests.get(event.id) ?? null);
}

export async function listEvents(
  db: Db,
  userId: string,
  filters: { status?: EventStatus; eventType?: EventType },
): Promise<EventDto[]> {
  const rows = await eventRepo.listForUser(db, userId, filters);
  const ids = rows.map((r) => r.id);
  const [anchors, latests] = await Promise.all([
    noteRepo.anchorNotesFor(db, ids),
    noteRepo.latestNotesFor(db, ids),
  ]);
  return rows.map((r) => toEventDto(r, anchors.get(r.id) ?? null, latests.get(r.id) ?? null));
}

export async function getEventDetail(db: Db, userId: string, id: number): Promise<EventDetailDto> {
  const event = await eventRepo.getForUser(db, userId, id);
  if (!event) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  const [notes, linked] = await Promise.all([
    noteRepo.listForEvent(db, id),
    eventRepo.listLinkedActivities(db, id),
  ]);
  const anchor = notes.find((n) => n.isAnchor) ?? null;
  const latest = notes.length > 0 ? notes[notes.length - 1] : null;
  const eventDto = toEventDto(event, anchor, latest);
  return toEventDetailDto(
    eventDto,
    notes,
    linked.map((a) => ({
      id: a.id,
      name: a.name,
      startDateLocal: a.startDateLocal.toISOString(),
      sportType: a.sportType,
    })),
  );
}

export async function listActivityEvents(db: Db, activityId: number): Promise<ActivityEventDto[]> {
  const rows = await eventRepo.listForActivity(db, activityId);
  return rows.map(toActivityEventDto);
}

/** Same message whether the event or the activity is the missing/foreign one —
 * the response must not tell a caller which id it does not own. */
const LINK_NOT_FOUND = "Event or activity not found or unauthorized";

export async function listEventsForActivity(
  db: Db,
  userId: string,
  activityId: number,
): Promise<ActivityEventDto[]> {
  const activityStart = await activityRepo.getStartDateLocalForUser(db, userId, activityId);
  if (!activityStart) {
    throw new AppError(404, LINK_NOT_FOUND);
  }
  return listActivityEvents(db, activityId);
}

export async function linkEventToActivity(
  db: Db,
  userId: string,
  eventId: number,
  activityId: number,
): Promise<ActivityEventDto> {
  const [event, activityStart] = await Promise.all([
    eventRepo.getForUser(db, userId, eventId),
    activityRepo.getStartDateLocalForUser(db, userId, activityId),
  ]);
  if (!event || !activityStart) {
    throw new AppError(404, LINK_NOT_FOUND);
  }
  const linked = await eventRepo.linkToActivity(db, eventId, activityId, activityStart);
  return toActivityEventDto(linked);
}

export interface CreateEventInput {
  activityId?: number;
  eventType: EventType;
  bodyLocation?: string | null;
  note: string;
  startTime?: string;
  status?: EventStatus;
}

export async function createEvent(
  db: Db,
  userId: string,
  input: CreateEventInput,
): Promise<EventDto> {
  let occurredAt: Date;
  if (input.activityId !== undefined) {
    const activityStart = await activityRepo.getStartDateLocalForUser(db, userId, input.activityId);
    if (!activityStart) {
      throw new AppError(404, "Activity not found or unauthorized");
    }
    occurredAt = input.startTime ? new Date(input.startTime) : activityStart;
  } else {
    occurredAt = input.startTime ? new Date(input.startTime) : new Date();
  }

  const status = input.status ?? "active";
  const values: InsertEvent = {
    userId,
    eventType: input.eventType,
    bodyLocation: input.bodyLocation ?? null,
    startTime: occurredAt,
    lastOccurrence: occurredAt,
    status,
    resolvedAt: status === "resolved" ? occurredAt : null,
  };

  const { event, anchorNote } = await eventRepo.createEventWithAnchor(
    db,
    values,
    { note: input.note, source: "user", occurredAt },
    input.activityId,
  );
  return toEventDto(event, anchorNote, anchorNote);
}

export interface UpdateEventInput {
  eventType?: EventType;
  bodyLocation?: string | null;
  status?: EventStatus;
}

export async function updateEvent(
  db: Db,
  userId: string,
  id: number,
  patch: UpdateEventInput,
): Promise<EventDto> {
  const updates: Partial<InsertEvent> = { updatedAt: new Date() };
  if (patch.eventType !== undefined) updates.eventType = patch.eventType;
  if (patch.bodyLocation !== undefined) updates.bodyLocation = patch.bodyLocation;
  if (patch.status !== undefined) {
    updates.status = patch.status;
    updates.resolvedAt = patch.status === "resolved" ? new Date() : null;
  }

  const updated = await eventRepo.updateForUser(db, userId, id, updates);
  if (!updated) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  return hydrateEvent(db, updated);
}

export async function unlinkEvent(
  db: Db,
  userId: string,
  id: number,
  activityId: number,
): Promise<DeleteEventDto> {
  const result = await eventRepo.unlinkFromActivity(db, userId, id, activityId);
  if (!result.found) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  return { unlinked: result.unlinked, deleted: result.deleted };
}

export async function deleteEvent(db: Db, userId: string, id: number): Promise<DeleteEventDto> {
  const result = await eventRepo.deleteForUser(db, userId, id);
  if (!result.found) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  return { unlinked: false, deleted: result.deleted };
}

export interface AddNoteInput {
  note: string;
  occurredAt?: string;
  trend?: NoteTrend;
  severity?: number;
}

export async function addNote(
  db: Db,
  userId: string,
  eventId: number,
  input: AddNoteInput,
): Promise<EventNoteDto> {
  const event = await eventRepo.getForUser(db, userId, eventId);
  if (!event) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const created = await noteRepo.createNote(db, {
    eventId,
    userId,
    note: input.note,
    source: "user",
    occurredAt,
    trend: input.trend ?? null,
    severity: input.severity ?? null,
    isAnchor: false,
  });
  await noteRepo.touchEventForNote(db, eventId, occurredAt);
  return toEventNoteDto(created);
}

export interface UpdateNoteInput {
  note?: string;
  occurredAt?: string;
  trend?: NoteTrend | null;
  severity?: number | null;
}

export async function updateNote(
  db: Db,
  userId: string,
  eventId: number,
  noteId: number,
  patch: UpdateNoteInput,
): Promise<EventNoteDto> {
  const updates: Partial<InsertEventNote> = {};
  if (patch.note !== undefined) updates.note = patch.note;
  if (patch.occurredAt !== undefined) updates.occurredAt = new Date(patch.occurredAt);
  if (patch.trend !== undefined) updates.trend = patch.trend;
  if (patch.severity !== undefined) updates.severity = patch.severity;

  const updated = await noteRepo.updateNoteForUser(db, userId, eventId, noteId, updates);
  if (!updated) {
    throw new AppError(404, "Note not found or unauthorized");
  }
  if (updates.occurredAt) {
    await noteRepo.touchEventForNote(db, eventId, updates.occurredAt);
  }
  return toEventNoteDto(updated);
}

export async function deleteNote(
  db: Db,
  userId: string,
  eventId: number,
  noteId: number,
): Promise<{ deleted: boolean }> {
  const result = await noteRepo.deleteNoteForUser(db, userId, eventId, noteId);
  if (!result.found) {
    throw new AppError(404, "Note not found or unauthorized");
  }
  if (result.isAnchor) {
    throw new AppError(400, "The anchor note is the event's summary and cannot be deleted");
  }
  return { deleted: result.deleted };
}
