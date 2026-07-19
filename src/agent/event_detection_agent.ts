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
          "The id of an existing event from `recentEvents` that this mention refers to. MUST be exactly null (NOT 0, NOT -1, NOT a placeholder integer) when introducing a new event. Only set when an entry in `recentEvents` has BOTH the same eventType AND the same bodyLocation as the event you are emitting.",
        ),
      eventType: z.enum(eventTypeEnum.enumValues).describe("The category of the event."),
      bodyLocation: z
        .string()
        .nullable()
        .describe(
          "Body location for an injury. Include a side ONLY when the user explicitly states one ('right knee', 'left achilles'). When the user mentions a body part without a side ('hofta', 'kneet', 'foten'), use the body part alone ('hip', 'knee', 'foot') — do NOT guess a side. Null for ILLNESS / MEDICAL_VISIT / PHYSIO_VISIT / OTHER unless a specific body part is the subject.",
        ),
      description: z
        .string()
        .describe(
          "A short (5–15 word) summary of the underlying CONDITION, not this specific activity's experience of it. Examples: 'Recurring right hip pain', 'Achilles tendon pain', 'Cold/flu'. Avoid activity-specific phrasing like 'felt pain during today's run'. This becomes the event's ANCHOR note (its timeless canonical summary). MUST be written in the SAME language the user wrote the title/description/notes in (Norwegian text -> Norwegian description). Do NOT translate.",
        ),
      updateText: z
        .string()
        .describe(
          "A one-line, activity-SPECIFIC observation of the condition AS IT APPEARED IN THIS activity. Unlike `description` (the timeless summary), this SHOULD reference today's occurrence — e.g. 'Fortsatt vondt i høyre hofte etter dagens langtur', 'Cold symptoms lingering this morning'. It is appended as a dated timeline note when this event turns out to be a recurrence of an existing one. Written in the SAME language as the user's text. Keep it to one short sentence.",
        ),
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

### Categories (eventType)
- **INJURY**: pain in a specific body part (hip, knee, achilles, foot, back, etc.). Pain is the trigger word.
- **ILLNESS**: actual sickness — cold (forkjølelse), flu, fever, sore throat (vondt i halsen), stomach bug. NEVER for fatigue, soreness, heavy legs, or pain in a body part.
- **MEDICAL_VISIT**: doctor/hospital visit.
- **PHYSIO_VISIT**: physiotherapist (fysio, fysioterapeut) visit.
- **OTHER**: physical-state issues that don't fit above (e.g. blisters, dehydration episode).

### Language
The text may be written in any language — commonly English or Norwegian. Treat clear pain/injury/illness mentions identically regardless of language.
- **\`bodyLocation\`**: always English. Translate body parts ("hofte" -> "hip", "kne" -> "knee", "korsrygg" -> "lower back", "akilles" -> "achilles", "fotbue" -> "foot arch"). Include a side ONLY when the user explicitly states one ("høyre hofte" -> "right hip", "venstre kne" -> "left knee"). When no side is stated ("hofta", "kneet"), use the body part alone ("hip", "knee") — DO NOT guess a side, even to match an existing event.
- **\`description\`**: always in the SAME language the user wrote in. Short condition summary, not activity-specific phrasing.

### What to detect (be selective)
- Detect ONLY explicit mentions. Do NOT infer from generic phrases like "tough run", "tired", "felt slow", "long day".
- Most activities will produce zero events — return an empty array unless there is a clear mention.
- A single note may contain MULTIPLE distinct events. Extract each one separately (e.g. knee pain AND foot pain in the same note → two events).
- Distinguish kinds of injury on the same body part: a knee strain and a knee bruise are SEPARATE events.

### Pain vs soreness (CRITICAL)
The trigger word determines whether something is an event:
- **Pain words → EVENT**: "vondt", "smerter", "smerte", "pain", "ache", "hurts", "injury", "strain", "skade", "strekk".
- **Soreness words → NOT an event**: "støl", "støle", "stiv", "stive", "sore", "stiff", "tight", "ømme bein", "tunge bein", "heavy legs". These describe expected training response.
- Soreness words paired with a body part are STILL not events ("støl i leggene", "sore quads", "litt stiv i hofta", "støl i bena").
- A pain word IS an event even with a softener: "vondt i hofta, men løsnet" = EVENT. "litt vondt" = EVENT. "fortsatt vondt" = EVENT (and likely a link to a recent event).
- Softeners ("men løsnet", "ga seg etterhvert", "ble bedre") describe the trajectory — they do NOT cancel the event.

### What is NEVER an event
- Negations of an issue: "ingen smerte", "ingen vondt", "no pain", "felt fine", "føltes bra", "kjente ikke noe". When a sentence contains BOTH a problem mention AND its negation, the negation wins ONLY if the problem word is soreness, not pain. So "litt støl, men ingen smerte" = no event. "litt vondt, men ingen smerter nå" = still an event (pain occurred).
- General fatigue: "tunge bein", "sliten kropp", "lite overskudd", "kjenner det i bena", "rough day", "off day", "heavy". These are not illness and not injury.
- Mentions of training advice or things to work on ("burde trent mer hofte" = "should train more hip"). This is intent, not pain.

### Linking to existing events
- Only set \`linkedEventId\` when an entry in \`recentEvents\` has BOTH the same \`eventType\` AND the same \`bodyLocation\` (after side normalisation) as the event you are emitting. If body parts differ, return \`linkedEventId: null\`. A right-foot injury must NEVER link to a hip event, a calves event, etc.
- If no entry matches, \`linkedEventId\` MUST be exactly null. Never 0, never -1, never a placeholder.
- If a candidate has \`status=resolved\`, only link if the user explicitly says the issue returned.
- If a candidate has \`alreadyLinkedToThisActivity=true\`, the condition is ALREADY recorded for the current activity. Do NOT emit it again — not as a link, not as a new event for the same body part.

### Resolution
- Set \`markResolved: true\` only when the user explicitly states the condition is over / better / resolved.

### Body location
- Required for INJURY when the body part is mentioned (e.g. "right knee", "left achilles", "lower back", "hip" without side).
- Use null when no specific body part is involved (most ILLNESS, MEDICAL_VISIT, PHYSIO_VISIT, OTHER).

### description vs updateText (BOTH are required on every event)
- **\`description\`** = the timeless CONDITION summary. It becomes the event's anchor note and is written once. Keep it activity-agnostic ("Smerter i høyre hofte", "Forkjølelse").
- **\`updateText\`** = a one-line, THIS-ACTIVITY observation. It is appended to the timeline as a dated note when the event recurs. It SHOULD reference today's occurrence ("Fortsatt vondt i høyre hofte etter dagens økt", "Forkjølelsen henger igjen"). Never leave it as a copy of \`description\` — it is the per-occurrence trace of how the condition is going.
- Both fields use the user's language.

### Worked examples
These illustrate the rules above. Each example shows notes -> the events array you should produce.

Example 1 — pain with softener IS an event
notes: "litt vondt i høyre hofte, men løsnet etterhvert"
recentEvents: (none for hip)
→ [{ linkedEventId: null, eventType: "INJURY", bodyLocation: "right hip", description: "Smerter i høyre hofte", updateText: "Litt vondt i høyre hofte i dag, men løsnet etterhvert", markResolved: false, attributes: [] }]

Example 2 — recurring pain links only when body part matches
notes: "fortsatt vondt i høyre hofte"
recentEvents: [{ id: 5, eventType: "INJURY", bodyLocation: "right hip", description: "Smerter i høyre hofte", ... }]
→ [{ linkedEventId: 5, eventType: "INJURY", bodyLocation: "right hip", description: "Smerter i høyre hofte", updateText: "Fortsatt vondt i høyre hofte etter dagens økt", markResolved: false, attributes: [] }]

Example 3 — DO NOT link when body part differs
notes: "litt vondt i kneet"
recentEvents: [{ id: 5, eventType: "INJURY", bodyLocation: "right hip", ... }]
→ [{ linkedEventId: null, eventType: "INJURY", bodyLocation: "knee", description: "Smerter i kneet", updateText: "Litt vondt i kneet under dagens økt", markResolved: false, attributes: [] }]
(Knee ≠ hip — must be a new event.)

Example 4 — soreness + no-pain disclaimer is NOT an event
notes: "føltes bra! litt støl i kroppen etter styrke, men ingen smerte!"
→ []

Example 5 — soreness alone with a body part is NOT an event
notes: "veldig tungt, ganske støl. spesielt i hofta"
→ []
(Soreness in hip, no pain word — not an event.)

Example 6 — multiple events in one note, with a negation
notes: "Litt smerter i kneet underveis, innsiden. kjente ikke noe i hofta, og litt vondt under fotbuen på venstre"
→ [
  { linkedEventId: null, eventType: "INJURY", bodyLocation: "knee", description: "Smerter på innsiden av kneet", updateText: "Smerter på innsiden av kneet underveis i dag", markResolved: false, attributes: [{ key: "side_of_joint", type: "string", value: "inner" }] },
  { linkedEventId: null, eventType: "INJURY", bodyLocation: "left foot arch", description: "Smerter under venstre fotbue", updateText: "Litt vondt under venstre fotbue i dag", markResolved: false, attributes: [] }
]
(Hip is negated → skip. Knee and foot arch are separate events.)

Example 7 — fatigue + pain → only the pain is an event
notes: "tunge bein, lite overskudd, vondt i hofta"
recentEvents: [{ id: 5, eventType: "INJURY", bodyLocation: "right hip", ... }]
→ [{ linkedEventId: null, eventType: "INJURY", bodyLocation: "hip", description: "Smerter i hofta", updateText: "Vondt i hofta under dagens økt", markResolved: false, attributes: [] }]
(Fatigue is not an event. The user did not say "høyre"/"venstre", so bodyLocation is "hip" without a side — and that means it does NOT link to event 5 which has bodyLocation "right hip".)

Example 8 — illness is sickness, not fatigue
notes: "Kriger med en liten forkjølelse 🤧"
→ [{ linkedEventId: null, eventType: "ILLNESS", bodyLocation: null, description: "Forkjølelse", updateText: "Kriger med en liten forkjølelse i dag", markResolved: false, attributes: [] }]

Example 9 — fatigue alone is NEVER an illness
notes: "ting økt, kjenner det i bena etter tirsdag"
→ []

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
