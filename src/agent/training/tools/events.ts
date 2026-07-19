import { z } from "zod";
import * as eventController from "../../../controllers/event_controller";
import { eventStatusEnum, eventTypeEnum } from "../../../schema/enums";
import { defineTool } from "../tool_types";
import { resolveOwnedActivity } from "./_shared";

const listEvents = defineTool({
  name: "list_events",
  description:
    "List the user's health events (injuries, illnesses, medical/physio visits) with body location, status, first/last occurrence, the anchor note (canonical summary) and the latest note. Filter by status or type.",
  keywords: ["events", "injury", "injuries", "illness", "sick", "health", "medical", "physio"],
  requires: "db",
  params: z.object({
    status: z.enum(eventStatusEnum.enumValues).optional(),
    eventType: z.enum(eventTypeEnum.enumValues).optional(),
  }),
  handler: (ctx, args) =>
    eventController.listEvents(ctx.db, ctx.userId, {
      status: args.status,
      eventType: args.eventType,
    }),
});

const getActivityEvents = defineTool({
  name: "get_activity_events",
  description:
    "Health events linked to a specific activity (e.g. an injury flagged during a run), each with its anchor note.",
  keywords: ["events", "activity", "injury", "linked", "health"],
  requires: "db",
  params: z.object({ activityId: z.number().int() }),
  handler: async (ctx, args) => {
    await resolveOwnedActivity(ctx, args.activityId);
    return eventController.listActivityEvents(ctx.db, args.activityId);
  },
});

const getEvent = defineTool({
  name: "get_event",
  description:
    "Full detail for one health event: the event, its dated note timeline (how the condition has trended over time), and the activities linked to it. Use to follow the trace of an injury/illness.",
  keywords: ["event", "injury", "illness", "timeline", "notes", "trend", "history", "health"],
  requires: "db",
  params: z.object({ eventId: z.number().int() }),
  handler: (ctx, args) => eventController.getEventDetail(ctx.db, ctx.userId, args.eventId),
});

export const eventTools = [listEvents, getActivityEvents, getEvent];
