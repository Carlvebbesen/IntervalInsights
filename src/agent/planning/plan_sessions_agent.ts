import type { ChatOpenAI } from "@langchain/openai";
import { getPlanBuilderModel, invokeStructured } from "../model";
import {
  type GenerateSessionsOutput,
  GenerateSessionsOutputSchema,
  type PlanMacroWeek,
} from "./plan_builder_schemas";
import type { AthleteContext } from "./plan_builder_state";

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

  ### MACRO PLAN
${weeksBlock(weeks)}
${feedbackBlock}

  ### TASK
  For EVERY week output its weekIndex and an ordered list of sessions. Each
  session has a date (YYYY-MM-DD, inside that week), a sessionType, a title, an
  optional description, and an optional structure.

  ### RULES
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
