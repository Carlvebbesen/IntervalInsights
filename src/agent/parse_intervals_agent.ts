import { z } from "zod";
import type { TrainingType } from "../schema/enums";
import { workoutSet } from "./initial_analysis_agent";
import { invokeStructured } from "./model";
import { venuePromptBlock } from "./running_venues";

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
- One Set per repeating series. **10x1000m** → 1 Set, set_reps=1, 1 Step with reps=10.
- **3x(3km+2km+1km)** → 1 Set, set_reps=3, 3 Steps (3000m, 2000m, 1000m) each with reps=1.
- Always convert distance to **METERS** and time to **SECONDS**.
- Recovery between reps goes on the Step. Recovery between sets goes on the Set.
- Ignore warmup/cooldown — only capture the "work" segments.
- Return an empty 'sets' array if the text doesn't describe a structured workout.
${typeHint}

${venuePromptBlock()}

### USER TEXT
"""${text}"""

### TASK
Return the structured sets.
`;

  return invokeStructured(parseIntervalsOutput, prompt, "parse intervals from text");
}
