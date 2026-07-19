import type { ChatOpenAI } from "@langchain/openai";
import { getPlanBuilderModel, invokeStructured } from "../model";
import {
  type GenerateSessionsOutput,
  GenerateSessionsOutputSchema,
  type PlanMacroWeek,
} from "./plan_builder_schemas";
import type { AthleteContext } from "./plan_builder_state";

function vocabularyBlock(context: AthleteContext): string {
  const v = context.workoutVocabulary;
  const types = v.types.length ? v.types.join(", ") : "no classified sessions on record";
  const structured = v.hasStructuredIntervalHistory
    ? "has structured-interval history"
    : "NO structured-interval history — introduce intervals gradually and keep sessions simple";
  return `  - Session types the athlete has actually done: ${types}\n  - Interval experience: ${structured}`;
}

function healthBlock(context: AthleteContext): string {
  if (context.activeHealthEvents.length === 0) return "  - Active injuries/illnesses: none.";
  const items = context.activeHealthEvents
    .map((e) => {
      const loc = e.bodyLocation ? ` (${e.bodyLocation})` : "";
      return `    - ${e.type}${loc} since ${e.since}: ${e.description}`;
    })
    .join("\n");
  return `  - ACTIVE injuries/illnesses (keep intensity conservative, avoid aggravating sessions):\n${items}`;
}

function weeksBlock(weeks: PlanMacroWeek[]): string {
  return weeks
    .map((w) => {
      const keys = w.keySessions.length ? w.keySessions.join(", ") : "(none)";
      return `- Week ${w.weekIndex} (${w.startDate}, ${w.phase}): target ${(w.targetDistanceMeters / 1000).toFixed(1)} km — key sessions: ${keys}`;
    })
    .join("\n");
}

// Session generation is chunked into batches of at most this many weeks per
// structured LLM call — a single all-weeks call on a long plan blows the
// planner model's request budget (see getPlanBuilderModel timeout).
export const SESSION_BATCH_WEEKS = 4;

export async function invokeGenerateSessionsAgent(
  context: AthleteContext,
  weeks: PlanMacroWeek[],
  feedback: string[],
  model: ChatOpenAI = getPlanBuilderModel(),
): Promise<GenerateSessionsOutput | null> {
  const feedbackBlock = feedback.length
    ? `\n  ### ATHLETE FEEDBACK ON PRIOR DRAFTS (apply all, most recent last)\n${feedback.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}`
    : "";

  const prompt = `
  You are an expert running coach turning a macro plan into concrete weekly
  sessions for an athlete whose max HR is ${context.maxHeartRate ?? "unknown"}.

  ### ATHLETE EXPERIENCE & HEALTH
${vocabularyBlock(context)}
${healthBlock(context)}

  ### MACRO PLAN
${weeksBlock(weeks)}
${feedbackBlock}

  ### TASK
  For EVERY week output its weekIndex and an ordered list of sessions. Each
  session has a date (YYYY-MM-DD, inside that week), a sessionType, a title, an
  optional description, and an optional structure.

  ### RULES
  - Match session complexity to the athlete's experience above. If they have NO
    structured-interval history, prefer simpler sessions (strides, short fartlek)
    and introduce rep workouts gradually rather than prescribing complex sets
    early. Favour session types they have actually done.
  - Keep intensity conservative around any ACTIVE injury/illness — avoid
    sessions likely to aggravate the noted body location. When there is an active
    injury, some easy volume may be delivered as low-impact cross-training
    (elliptical / bike / pool) in place of an easy run; the plan applies this
    substitution deterministically, so you may simply keep those as easy runs.
  - Cover each week's keySessions as structured quality sessions; fill the rest
    with EASY / LONG / RECOVERY runs to reach the weekly target. At most 7
    sessions per week.
  - Structure: EASY, LONG and RECOVERY sessions get NO structure (null). Only
    interval-type sessions (intervals, tempo, hills, sprints, fartlek) get a
    structure with sets/steps carrying reps + work values.
  - NEVER output any pace, speed, or heart-rate target. Leave every target_pace
    null. The plan stores intent only; paces are computed later.`;

  return invokeStructured(GenerateSessionsOutputSchema, prompt, "generate plan sessions", model);
}
