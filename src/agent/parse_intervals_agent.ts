import { z } from "zod";
import type { TrainingType } from "../schema/enums";
import { reconcileSetsBlowup, workoutSet, workoutStep } from "./initial_analysis_agent";
import { invokeStructured, isRateLimitError } from "./model";
import { venuePromptBlock } from "./running_venues";
import { STRUCTURE_EXTRACTION_RULES } from "./structure_prompt_rules";

// Parse-agent-only extension of the shared step: an EXPLICITLY-stated target pace.
// The classifier's `workoutStep` is left untouched (unified-workout-structure-model
// convention) — only free-text parsing surfaces a declared pace.
export const parseWorkoutStep = workoutStep.extend({
  target_pace_string: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The target pace EXACTLY as written in the text (e.g. '3:45', '4:10 min/km'). Only set this when the text explicitly states a pace for this work interval; otherwise leave it null.",
    ),
});

export const parseWorkoutSet = workoutSet.extend({
  steps: z.array(parseWorkoutStep),
});

export type ParseWorkoutSet = z.infer<typeof parseWorkoutSet>;

export const parseIntervalsOutput = z.object({
  sets: z
    .array(parseWorkoutSet)
    .describe(
      "Workout sets parsed from the user's free text. One set per repeating series. Use METERS for distance and SECONDS for time.",
    ),
});

export type ParseIntervalsOutput = z.infer<typeof parseIntervalsOutput>;

export async function invokeParseIntervalsAgent(
  text: string,
  trainingType: TrainingType | null | undefined,
): Promise<ParseIntervalsOutput | null> {
  const typeHint = trainingType
    ? `\nUser has chosen training type: **${trainingType}** — interpret the text consistent with this.`
    : "";

  const prompt = `
You convert a user's free-text description of a structured workout into a typed list of workout sets.

### RULES
${STRUCTURE_EXTRACTION_RULES}
8. **Return an empty 'sets' array if the text doesn't describe a structured workout.**
9. **Target pace — extract ONLY when the text explicitly states one.** If the text names a pace for a work interval (e.g. "10x1000m @ 3:45", "3:45/km", "@ 4:10 min/km"), set that step's 'target_pace_string' to the pace exactly as written. NEVER infer, estimate, or calculate a pace from distances or durations — if no pace is explicitly stated, leave 'target_pace_string' null.
${typeHint}

${venuePromptBlock()}

### USER TEXT
"""${text}"""

### TASK
Return the structured sets.
`;

  const result = await invokeStructured(
    parseIntervalsOutput,
    prompt,
    "parse intervals from text",
  ).catch((err) => (isRateLimitError(err) ? null : Promise.reject(err)));
  if (!result) return result;
  // reconcileSetsBlowup is typed to the shared `workoutSet` but preserves each
  // step verbatim (incl. target_pace_string) at runtime; re-validate to recover
  // the paced type without an escape-hatch cast.
  const sets = z.array(parseWorkoutSet).parse(reconcileSetsBlowup(result.sets));
  return { sets };
}
