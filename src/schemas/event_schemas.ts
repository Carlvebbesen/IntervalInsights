import "zod-openapi/extend";
import { z } from "zod";
import { eventStatusEnum, eventTypeEnum, noteSourceEnum, noteTrendEnum } from "../schema/enums";

export const EventNoteSchema = z
  .object({
    id: z.number(),
    eventId: z.number(),
    note: z.string(),
    source: z.enum(noteSourceEnum.enumValues),
    occurredAt: z.string(),
    trend: z.enum(noteTrendEnum.enumValues).nullable(),
    severity: z.number().nullable(),
    isAnchor: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "EventNote" });

export const ActivityEventSchema = z
  .object({
    id: z.number(),
    eventType: z.enum(eventTypeEnum.enumValues),
    bodyLocation: z.string().nullable(),
    anchorNote: EventNoteSchema.nullable(),
    startTime: z.string(),
    lastOccurrence: z.string(),
    status: z.enum(eventStatusEnum.enumValues),
    resolvedAt: z.string().nullable(),
  })
  .openapi({ ref: "ActivityEvent" });

export const EventListItemSchema = ActivityEventSchema.extend({
  latestNote: EventNoteSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "EventListItem" });

export const EventListResponseSchema = z
  .object({
    events: z.array(EventListItemSchema),
  })
  .openapi({ ref: "EventListResponse" });

export const LinkedActivitySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    startDateLocal: z.string(),
    sportType: z.string(),
  })
  .openapi({ ref: "LinkedActivity" });

export const EventDetailSchema = z
  .object({
    event: EventListItemSchema,
    notes: z.array(EventNoteSchema),
    linkedActivities: z.array(LinkedActivitySchema),
  })
  .openapi({ ref: "EventDetail" });

export const DeleteEventResponseSchema = z
  .object({
    unlinked: z.boolean(),
    deleted: z.boolean(),
  })
  .openapi({ ref: "DeleteEventResponse" });

export const DeleteEventNoteResponseSchema = z
  .object({
    deleted: z.boolean(),
  })
  .openapi({ ref: "DeleteEventNoteResponse" });
