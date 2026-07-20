import type { ChatOpenAI } from "@langchain/openai";
import { getPlanBuilderModel, invokeStructured } from "../model";
import {
  type GenerateSessionsOutput,
  GenerateSessionsOutputSchema,
  type PlanMacroWeek,
} from "./plan_builder_schemas";
import type { AthleteContext } from "./plan_builder_state";
import { constraintsBlock, intakeBriefBlock } from "./plan_macro_agent";

function vocabularyBlock(context: AthleteContext): string {
  const v = context.workoutVocabulary;
  const types = v.types.length ? v.types.join(", ") : "no classified sessions on record";
  const structured = v.hasStructuredIntervalHistory
    ? "has structured-interval history"
    : "NO structured-interval history — introduce intervals gradually and keep sessions simple";
  const repertoire = v.structures.length
    ? `\n  - Proven interval repertoire (prefer these shapes, progressed gradually): ${v.structures
        .map(
          (s) =>
            `${s.name} (done ${s.activityCount}x${s.lastDoneAt ? `, last ${s.lastDoneAt}` : ""})`,
        )
        .join("; ")}`
    : "";
  return `  - Session types the athlete has actually done: ${types}\n  - Interval experience: ${structured}${repertoire}`;
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
  constraintsText?: string | null,
  priorQualitySessions: string[] = [],
  intakeBriefText?: string | null,
  model: ChatOpenAI = getPlanBuilderModel(),
): Promise<GenerateSessionsOutput | null> {
  const feedbackBlock = feedback.length
    ? `\n  ### ATHLETE FEEDBACK ON PRIOR DRAFTS (apply all, most recent last)\n${feedback.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}`
    : "";

  const priorBlock = priorQualitySessions.length
    ? `\n  ### SESSIONS ALREADY PLANNED (earlier weeks — continue their interval progression)\n${priorQualitySessions.map((line) => `  - ${line}`).join("\n")}`
    : "";

  const prompt = `
  You are an expert running coach turning a macro plan into concrete weekly
  sessions for an athlete whose max HR is ${context.maxHeartRate ?? "unknown"}.

  ### ATHLETE EXPERIENCE & HEALTH
${vocabularyBlock(context)}
${healthBlock(context)}

  ### MACRO PLAN
${weeksBlock(weeks)}
${priorBlock}
${constraintsBlock(constraintsText)}
${intakeBriefBlock(intakeBriefText)}
${feedbackBlock}

  ### TASK
  For EVERY week output its weekIndex and an ordered list of sessions. Each
  session has a date (YYYY-MM-DD, inside that week), a sessionType, a title, an
  optional description, and an optional structure.

  ### RULES
  - Repeat and progress a small rotation of interval shapes across the plan
    (e.g. 4x1000m → 5x1000m → 6x1000m) instead of inventing a new shape each
    week. Prefer shapes from the athlete's proven interval repertoire above, and
    continue the progression of any SESSIONS ALREADY PLANNED in earlier weeks.
  - In build or peak weeks, when the week has at least 5 run days, a second
    rep-interval session is allowed within the week's key sessions.
  - Strides belong as a short finisher mentioned in an easy run's description
    ("finish with 6 x 100 m relaxed strides"), NEVER as a standalone SPRINTS
    session. Plan a standalone sprint or hill-sprint session only when the
    athlete's goal or recent history clearly calls for it.
  - Match session complexity to the athlete's experience above. If they have NO
    structured-interval history, prefer simpler sessions (strides, short fartlek)
    and introduce rep workouts gradually rather than prescribing complex sets
    early. Favour session types they have actually done.
  - Keep intensity conservative around any ACTIVE injury/illness — avoid
    sessions likely to aggravate the noted body location. When there is an active
    injury, some easy volume may be delivered as low-impact cross-training
    (elliptical / spinning) in place of an easy run; the plan applies this
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
