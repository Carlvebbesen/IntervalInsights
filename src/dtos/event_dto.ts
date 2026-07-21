import type { z } from "zod";
import type { ActivityEventDao, EventDao } from "../repositories/event_repository";
import type { SelectEventNote } from "../schema";
import type {
  ActivityEventSchema,
  DeleteEventResponseSchema,
  EventDetailSchema,
  EventListItemSchema,
  EventNoteSchema,
  LinkedActivitySchema,
} from "../schemas/api_schemas";

export type EventDto = z.infer<typeof EventListItemSchema>;
export type ActivityEventDto = z.infer<typeof ActivityEventSchema>;
export type EventNoteDto = z.infer<typeof EventNoteSchema>;
export type EventDetailDto = z.infer<typeof EventDetailSchema>;
export type LinkedActivityDto = z.infer<typeof LinkedActivitySchema>;
export type DeleteEventDto = z.infer<typeof DeleteEventResponseSchema>;

export function toEventNoteDto(n: SelectEventNote): EventNoteDto {
  return {
    id: n.id,
    eventId: n.eventId,
    note: n.note,
    source: n.source,
    occurredAt: n.occurredAt.toISOString(),
    trend: n.trend,
    severity: n.severity,
    isAnchor: n.isAnchor,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

export function toActivityEventDto(dao: ActivityEventDao): ActivityEventDto {
  return {
    id: dao.id,
    eventType: dao.eventType,
    bodyLocation: dao.bodyLocation,
    anchorNote: dao.anchorNote ? toEventNoteDto(dao.anchorNote) : null,
    status: dao.status,
    startTime: dao.startTime.toISOString(),
    lastOccurrence: dao.lastOccurrence.toISOString(),
    resolvedAt: dao.resolvedAt?.toISOString() ?? null,
  };
}

export function toEventDto(
  dao: EventDao,
  anchorNote: SelectEventNote | null,
  latestNote: SelectEventNote | null,
): EventDto {
  return {
    id: dao.id,
    eventType: dao.eventType,
    bodyLocation: dao.bodyLocation,
    anchorNote: anchorNote ? toEventNoteDto(anchorNote) : null,
    latestNote: latestNote ? toEventNoteDto(latestNote) : null,
    status: dao.status,
    startTime: dao.startTime.toISOString(),
    lastOccurrence: dao.lastOccurrence.toISOString(),
    resolvedAt: dao.resolvedAt?.toISOString() ?? null,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}

export function toEventDetailDto(
  event: EventDto,
  notes: SelectEventNote[],
  linkedActivities: LinkedActivityDto[],
): EventDetailDto {
  return {
    event,
    notes: notes.map(toEventNoteDto),
    linkedActivities,
  };
}
