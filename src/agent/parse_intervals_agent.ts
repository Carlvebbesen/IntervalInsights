import { z } from "zod";
import type { TrainingType } from "../schema/enums";
import { reconcileSetsBlowup, workoutSet } from "./initial_analysis_agent";
import { invokeStructured, isRateLimitError } from "./model";
import { venuePromptBlock } from "./running_venues";
import { STRUCTURE_EXTRACTION_RULES } from "./structure_prompt_rules";

export const parseIntervalsOutput = z.object({
  sets: z
    .array(workoutSet)
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
  return result ? { ...result, sets: reconcileSetsBlowup(result.sets) } : result;
}
