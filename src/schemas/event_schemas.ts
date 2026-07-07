import "zod-openapi/extend";
import { z } from "zod";
import { eventStatusEnum, eventTypeEnum } from "../schema/enums";

export const ActivityEventSchema = z
  .object({
    id: z.number(),
    eventType: z.enum(eventTypeEnum.enumValues),
    bodyLocation: z.string().nullable(),
    description: z.string(),
    startTime: z.string(),
    lastOccurrence: z.string(),
    status: z.enum(eventStatusEnum.enumValues),
    resolvedAt: z.string().nullable(),
  })
  .openapi({ ref: "ActivityEvent" });

export const EventListItemSchema = ActivityEventSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "EventListItem" });

export const EventListResponseSchema = z
  .object({
    events: z.array(EventListItemSchema),
  })
  .openapi({ ref: "EventListResponse" });

export const DeleteEventResponseSchema = z
  .object({
    unlinked: z.boolean(),
    deleted: z.boolean(),
  })
  .openapi({ ref: "DeleteEventResponse" });
