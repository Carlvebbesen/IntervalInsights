import { type DeleteEventDto, type EventDto, toEventDto } from "../dtos/event_dto";
import { AppError } from "../error";
import * as activityRepo from "../repositories/activity_repository";
import * as eventRepo from "../repositories/event_repository";
import type { EventStatus, EventType, InsertEvent } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

/**
 * Business logic for events. Orchestrates the event + activity repositories and
 * enforces the domain rules (occurrence-date defaulting, resolvedAt syncing,
 * ownership). Throws AppError for expected failures; the router stays thin.
 */

export async function listEvents(
  db: Db,
  userId: string,
  filters: { status?: EventStatus; eventType?: EventType },
): Promise<EventDto[]> {
  const rows = await eventRepo.listForUser(db, userId, filters);
  return rows.map(toEventDto);
}

export interface CreateEventInput {
  activityId: number;
  eventType: EventType;
  bodyLocation?: string | null;
  description: string;
  /** ISO-8601 timestamp; defaults to the activity's start date when omitted. */
  startTime?: string;
  status?: EventStatus;
}

export async function createEvent(
  db: Db,
  userId: string,
  input: CreateEventInput,
): Promise<EventDto> {
  const activityStart = await activityRepo.getStartDateLocalForUser(db, userId, input.activityId);
  if (!activityStart) {
    throw new AppError(404, "Activity not found or unauthorized");
  }

  const occurredAt = input.startTime ? new Date(input.startTime) : activityStart;
  const status = input.status ?? "active";

  const values: InsertEvent = {
    userId,
    eventType: input.eventType,
    bodyLocation: input.bodyLocation ?? null,
    description: input.description,
    startTime: occurredAt,
    lastOccurrence: occurredAt,
    status,
    resolvedAt: status === "resolved" ? occurredAt : null,
  };

  const created = await eventRepo.createLinkedToActivity(db, values, input.activityId);
  return toEventDto(created);
}

export interface UpdateEventInput {
  eventType?: EventType;
  bodyLocation?: string | null;
  description?: string;
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
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.status !== undefined) {
    updates.status = patch.status;
    updates.resolvedAt = patch.status === "resolved" ? new Date() : null;
  }

  const updated = await eventRepo.updateForUser(db, userId, id, updates);
  if (!updated) {
    throw new AppError(404, "Event not found or unauthorized");
  }
  return toEventDto(updated);
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
