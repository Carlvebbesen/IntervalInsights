import { z } from "zod";
import type { EventStatus, EventType } from "../schema/enums";
import { eventTypeEnum } from "../schema/enums";
import { invokeStructured } from "./model";

export const eventDetectionOutput = z.object({
  events: z.array(
    z.object({
      linkedEventId: z
        .number()
        .nullable()
        .describe(
          "The id of an existing event from `recentEvents` that this mention refers to. Null when introducing a new event.",
        ),
      eventType: z.enum(eventTypeEnum.enumValues).describe("The category of the event."),
      bodyLocation: z
        .string()
        .nullable()
        .describe(
          "Body location for an injury (e.g. 'right knee', 'left achilles'). Null for ILLNESS / MEDICAL_VISIT / PHYSIO_VISIT / OTHER unless a specific body part is the subject.",
        ),
      description: z.string().describe("A 1–2 sentence narrative summarising the condition."),
      markResolved: z
        .boolean()
        .describe(
          "True only when the user clearly states the condition has resolved or is back to normal (e.g. 'feeling better', 'recovered', 'all clear').",
        ),
    }),
  ),
});

export type EventDetectionOutput = z.infer<typeof eventDetectionOutput>;

export type RecentEventCandidate = {
  id: number;
  eventType: EventType;
  bodyLocation: string | null;
  description: string;
  lastOccurrence: Date;
  status: EventStatus;
  alreadyLinkedToThisActivity: boolean;
};

export async function invokeEventDetectionAgent(
  title: string,
  description: string,
  userNotes: string,
  recentEvents: RecentEventCandidate[],
): Promise<EventDetectionOutput | null> {
  const recentBlock =
    recentEvents.length === 0
      ? "(no events recorded for this user in the last year)"
      : recentEvents
          .map(
            (r) =>
              `- id=${r.id} | type=${r.eventType} | bodyLocation=${r.bodyLocation ?? "—"} | status=${r.status} | lastOccurrence=${r.lastOccurrence.toISOString().slice(0, 10)} | alreadyLinkedToThisActivity=${r.alreadyLinkedToThisActivity} | description="${r.description}"`,
          )
          .join("\n");

  const prompt = `
You are extracting health events from a single Strava activity.

A health event is one of: an injury, an illness, a medical/doctor visit, a physiotherapy visit, or another physical-state issue worth tracking. The activity's title, description and the user's notes are below.

### What to detect (be selective)
- Detect ONLY explicit mentions. Do NOT infer from generic phrases like "tough run", "tired", "felt slow", "long day".
- Most activities will produce zero events — return an empty array unless there is a clear mention.
- Distinguish kinds of injury on the same body part: a knee strain and a knee bruise are SEPARATE events.

### Linking to existing events
- A list of the user's events from the last year is provided as \`recentEvents\` below.
- If the activity mentions the SAME condition as one of those entries (same body location AND same kind of issue), set \`linkedEventId\` to that entry's id.
- If a candidate has \`status=resolved\`, only link if the user explicitly says the issue returned.
- If a candidate has \`alreadyLinkedToThisActivity=true\`, the condition is ALREADY recorded for the current activity. Do NOT emit it again — neither as a link, nor as a new event for the same body part / condition.

### Resolution
- Set \`markResolved: true\` only when the user explicitly states the condition is over / better / resolved.

### Body location
- Required for INJURY when the body part is mentioned (e.g. "right knee", "left achilles", "lower back").
- Use null when no specific body part is involved (most ILLNESS, MEDICAL_VISIT, PHYSIO_VISIT, OTHER).

### Inputs
- Activity title: "${title || "—"}"
- Activity description: "${description || "—"}"
- User notes: "${userNotes || "—"}"

### recentEvents (last 12 months)
${recentBlock}

### Output
Return the structured object. Empty \`events\` array is the correct answer when nothing health-related is mentioned.
`;

  return invokeStructured(eventDetectionOutput, prompt, "detect events");
}
