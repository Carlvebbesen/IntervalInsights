import { z } from "zod";
import type { TrainingType } from "../schema/enums";
import { workoutSet } from "./initial_analysis_agent";
import { invokeStructured, isRateLimitError } from "./model";
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
- Comma-separated values are a STEP LIST, not decimals: "3,2,1 km" → 3 Steps (3000m, 2000m, 1000m); "2 x 3,2,2 km" → set_reps=2 with 3 Steps (3000m, 2000m, 2000m). A comma here is a separator, NOT a decimal point.
- **"N x (a, b, c)" = N SETS of the sequence a→b→c**: set_reps=N, one Step per item (reps=1) — e.g. "5 x (3,2,1 min)" → set_reps=5, Steps [180s, 120s, 60s]. Do NOT create 3 Steps with reps=N (that groups all a's, then all b's).
- **Compound / sequential workouts = ONE Set PER BLOCK, capture EVERY block**: when the text chains distinct blocks ("X followed by Y", "X then Y", Norwegian "etterfulgt av" / "deretter" / "så", or a top-level "X + Y" of two different schemes), emit a separate Set per block in order and never drop the trailing block — e.g. "4x1000m etterfulgt av 20x45/15" → Set 1 (reps=4, 1000m DISTANCE) + Set 2 (reps=20, 45s/15s TIME).
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

  return invokeStructured(parseIntervalsOutput, prompt, "parse intervals from text").catch((err) =>
    isRateLimitError(err) ? null : Promise.reject(err),
  );
}
