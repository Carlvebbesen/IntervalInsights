import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { logger } from "../../logger";
import { gptMiniModel, invokeStructured } from "../model";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_LONG_RUN_OFFSET } from "./guards";
import type { PlanNotice } from "./plan_builder_schemas";
import {
  DEFAULT_INTENSITY_AGGRESSIVENESS,
  DEFAULT_VOLUME_AGGRESSIVENESS,
  INTENSITY_AGGRESSIVENESS,
  type PlanBuilderInput,
  VOLUME_AGGRESSIVENESS,
} from "./plan_builder_state";

/**
 * The planner-input fields free-text review feedback is allowed to move. Every
 * other input (dates, race anchor, goal text) and every safety ceiling stays
 * out of reach — see `guards.ts` for the ones that are deliberately not here.
 */
const IntentFieldSchemas = {
  daysPerWeek: z
    .number()
    .int()
    .min(1)
    .max(7)
    .nullable()
    .describe("Run days per week the athlete asked for, else null"),
  preferredLongRunDay: z
    .number()
    .int()
    .min(0)
    .max(6)
    .nullable()
    .describe("Weekday for the long run: 0=Monday, 1=Tuesday … 6=Sunday. null if not mentioned"),
  volumeAggressiveness: z
    .enum(VOLUME_AGGRESSIVENESS)
    .nullable()
    .describe("How fast weekly mileage should build, else null"),
  intensityAggressiveness: z
    .enum(INTENSITY_AGGRESSIVENESS)
    .nullable()
    .describe("How much hard/quality work the athlete wants, else null"),
  maxWeeklyVolumeMeters: z
    .number()
    .int()
    .min(1_000)
    .max(400_000)
    .nullable()
    .describe("Weekly distance ceiling in METERS if the athlete named one, else null"),
};

const MacroIntentSchema = z.object(IntentFieldSchemas);
const SessionIntentSchema = z.object({
  daysPerWeek: IntentFieldSchemas.daysPerWeek,
  preferredLongRunDay: IntentFieldSchemas.preferredLongRunDay,
  intensityAggressiveness: IntentFieldSchemas.intensityAggressiveness,
});

export type PlanInputPatch = Partial<
  Pick<
    PlanBuilderInput,
    | "daysPerWeek"
    | "preferredLongRunDay"
    | "volumeAggressiveness"
    | "intensityAggressiveness"
    | "maxWeeklyVolumeMeters"
  >
>;

/** Which review gate is asking — the sessions gate cannot move macro-level volume dials. */
export type PlanReviewStage = "macro" | "sessions";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function currentValues(input: PlanBuilderInput): Record<string, string> {
  return {
    daysPerWeek: String(input.daysPerWeek ?? `${DEFAULT_DAYS_PER_WEEK} (default)`),
    preferredLongRunDay:
      WEEKDAYS[input.preferredLongRunDay ?? DEFAULT_LONG_RUN_OFFSET] ?? "Sunday (default)",
    volumeAggressiveness:
      input.volumeAggressiveness ?? `${DEFAULT_VOLUME_AGGRESSIVENESS} (default)`,
    intensityAggressiveness:
      input.intensityAggressiveness ?? `${DEFAULT_INTENSITY_AGGRESSIVENESS} (default)`,
    maxWeeklyVolumeMeters:
      input.maxWeeklyVolumeMeters != null
        ? `${(input.maxWeeklyVolumeMeters / 1000).toFixed(1)} km`
        : "none set",
  };
}

function buildPrompt(feedback: string, input: PlanBuilderInput, stage: PlanReviewStage): string {
  const cur = currentValues(input);
  const settings =
    stage === "macro"
      ? `  - Run days per week: ${cur.daysPerWeek}
  - Long-run day: ${cur.preferredLongRunDay}
  - Volume build-up: ${cur.volumeAggressiveness}
  - Intensity: ${cur.intensityAggressiveness}
  - Weekly distance ceiling: ${cur.maxWeeklyVolumeMeters}`
      : `  - Run days per week: ${cur.daysPerWeek}
  - Long-run day: ${cur.preferredLongRunDay}
  - Intensity: ${cur.intensityAggressiveness}`;

  return `
  You are parsing one piece of free-text feedback an athlete gave on a draft
  training plan. Your ONLY job is to detect whether they explicitly asked to
  change one of their plan settings, and to return the new value.

  ### THE ATHLETE'S CURRENT SETTINGS
${settings}

  ### THEIR FEEDBACK
  "${feedback}"

  ### RULES
  - Return a value ONLY when the feedback names that change explicitly and
    unambiguously. Everything else is null.
  - Vague reactions carry NO setting change — "this is too hard", "I don't like
    the Tuesday session", "make it better", "the second week looks odd" must
    return null for every field. Those are handled elsewhere as prose; do not
    guess a setting from them.
  - "I want to run 6 days" → daysPerWeek 6. "Long run on Saturday" →
    preferredLongRunDay 5. "Cap me at 60 km a week" → maxWeeklyVolumeMeters 60000.
  - "Build up faster / add more mileage over time" → volumeAggressiveness
    "progressive"; "ease into it" → "gradual".
  - "Add a quality session / more speed work" → intensityAggressiveness
    "challenging"; "less hard running" → "comfortable".
  - Do NOT restate a setting that already matches the current value.
  - Never infer a number the athlete did not state.`;
}

/**
 * Map one round of free-text review feedback onto a patch of the planner
 * inputs. Returns an EMPTY patch for feedback with no structured intent (the
 * common case) — the prose still reaches the planner prompt unchanged, so an
 * empty patch degrades to exactly the pre-extraction behaviour. Never throws:
 * an extraction failure must not fail the athlete's resume.
 */
export async function extractPlanInputPatch(
  feedback: string,
  input: PlanBuilderInput,
  stage: PlanReviewStage,
  model: ChatOpenAI = gptMiniModel,
): Promise<PlanInputPatch> {
  const schema = stage === "macro" ? MacroIntentSchema : SessionIntentSchema;
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await invokeStructured(
      schema as z.ZodType<Record<string, unknown>>,
      buildPrompt(feedback, input, stage),
      "extract plan feedback intent",
      model,
    );
  } catch (err) {
    logger.warn({ err }, "plan feedback intent extraction failed — falling back to prose only");
    return {};
  }
  if (!raw) return {};

  const patch: PlanInputPatch = {};
  const current = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    if (current[key] === value) continue;
    (patch as Record<string, unknown>)[key] = value;
  }
  return patch;
}

export function applyPlanInputPatch(
  input: PlanBuilderInput,
  patch: PlanInputPatch,
): PlanBuilderInput {
  return Object.keys(patch).length === 0 ? input : { ...input, ...patch };
}

function describeValue(field: keyof PlanInputPatch, value: unknown): string {
  if (field === "preferredLongRunDay") return WEEKDAYS[value as number] ?? String(value);
  if (field === "maxWeeklyVolumeMeters") return `${((value as number) / 1000).toFixed(1)} km/week`;
  if (field === "daysPerWeek") return `${value} run days/week`;
  return String(value);
}

const FIELD_LABELS: Record<keyof PlanInputPatch, string> = {
  daysPerWeek: "Run days per week",
  preferredLongRunDay: "Long-run day",
  volumeAggressiveness: "Volume build-up",
  intensityAggressiveness: "Intensity",
  maxWeeklyVolumeMeters: "Weekly distance ceiling",
};

/** One "I applied this" notice per patched field, for the next review gate. */
export function describePlanInputPatch(patch: PlanInputPatch): PlanNotice[] {
  return Object.entries(patch).map(([field, value]) => {
    const key = field as keyof PlanInputPatch;
    return {
      kind: "applied" as const,
      code: field,
      message: `${FIELD_LABELS[key]} updated to ${describeValue(key, value)} from your feedback.`,
    };
  });
}
