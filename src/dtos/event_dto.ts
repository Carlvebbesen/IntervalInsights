import type { z } from "zod";
import type { ActivityEventDao, EventDao } from "../repositories/event_repository";
import type {
  ActivityEventSchema,
  DeleteEventResponseSchema,
  EventListItemSchema,
} from "../schemas/api_schemas";

export type EventDto = z.infer<typeof EventListItemSchema>;
export type ActivityEventDto = z.infer<typeof ActivityEventSchema>;
export type DeleteEventDto = z.infer<typeof DeleteEventResponseSchema>;

export function toActivityEventDto(dao: ActivityEventDao): ActivityEventDto {
  return {
    id: dao.id,
    eventType: dao.eventType,
    bodyLocation: dao.bodyLocation,
    description: dao.description,
    status: dao.status,
    startTime: dao.startTime.toISOString(),
    lastOccurrence: dao.lastOccurrence.toISOString(),
    resolvedAt: dao.resolvedAt?.toISOString() ?? null,
  };
}

export function toEventDto(dao: EventDao): EventDto {
  return {
    id: dao.id,
    eventType: dao.eventType,
    bodyLocation: dao.bodyLocation,
    description: dao.description,
    status: dao.status,
    startTime: dao.startTime.toISOString(),
    lastOccurrence: dao.lastOccurrence.toISOString(),
    resolvedAt: dao.resolvedAt?.toISOString() ?? null,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}
