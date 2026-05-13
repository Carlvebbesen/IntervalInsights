import { z } from "zod";
import type { AttributeValueType, EventStatus, EventType } from "../schema/enums";
import { eventTypeEnum } from "../schema/enums";
import { invokeStructured } from "./model";

const eventAttributeSchema = z.discriminatedUnion("type", [
  z.object({ key: z.string(), type: z.literal("string"), value: z.string() }),
  z.object({ key: z.string(), type: z.literal("number"), value: z.number() }),
  z.object({ key: z.string(), type: z.literal("boolean"), value: z.boolean() }),
  z.object({ key: z.string(), type: z.literal("datetime"), value: z.string() }),
  z.object({ key: z.string(), type: z.literal("string_list"), value: z.array(z.string()) }),
  z.object({ key: z.string(), type: z.literal("number_list"), value: z.array(z.number()) }),
]);

export type EventAttributeOutput = z.infer<typeof eventAttributeSchema>;

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
      attributes: z
        .array(eventAttributeSchema)
        .describe(
          "Optional typed key/value facts that make this event easier to filter or sort later (e.g. severity, side, pain_scale, doctor_name, next_appointment). Reuse a key from `knownAttributeKeys` whenever the same concept applies — do not invent a near-duplicate. Keys must be lowercase snake_case. Empty array when nothing extra is worth recording.",
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

export type KnownAttributeKey = {
  key: string;
  valueType: AttributeValueType;
  sampleValue: string;
};

export async function invokeEventDetectionAgent(
  title: string,
  description: string,
  userNotes: string,
  recentEvents: RecentEventCandidate[],
  knownAttributeKeys: KnownAttributeKey[],
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

  const knownKeysBlock =
    knownAttributeKeys.length === 0
      ? "(no attribute keys recorded for this user yet — you may introduce new ones)"
      : knownAttributeKeys
          .map((k) => `- key="${k.key}" | type=${k.valueType} | sample=${k.sampleValue}`)
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

### Attributes (typed extra facts)
- Use \`attributes\` to capture additional facts mentioned by the user that would make the event easier to filter, sort, or group later — e.g. severity, side, pain_scale (number 1–10), doctor_name, clinic, medication, next_appointment (datetime), affected_muscles (string_list).
- DO NOT duplicate \`bodyLocation\`, \`eventType\`, or \`description\` as attributes.
- Only include attributes that are explicitly stated. Do not infer.
- **Key reuse is critical.** Keys recorded for this user before are listed under \`knownAttributeKeys\`. If the same concept applies, reuse the EXACT key string and type. Do not introduce variants like "pain_level" when "pain_scale" already exists.
- Keys must be lowercase snake_case.
- Pick the narrowest sensible \`type\`: numbers as "number", scales/counts as "number", yes/no as "boolean", dates as "datetime" (ISO-8601 string), lists as "string_list" or "number_list".

### Inputs
- Activity title: "${title || "—"}"
- Activity description: "${description || "—"}"
- User notes: "${userNotes || "—"}"

### recentEvents (last 12 months)
${recentBlock}

### knownAttributeKeys (reuse these before creating new keys)
${knownKeysBlock}

### Output
Return the structured object. Empty \`events\` array is the correct answer when nothing health-related is mentioned. Empty \`attributes\` array is fine when no extra facts are stated.
`;

  return invokeStructured(eventDetectionOutput, prompt, "detect events");
}
