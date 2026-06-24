import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { trainingTypeEnum } from "../schema";
import type { IntervalsIcuPrediction } from "../schema/activities";
import { normalizeActivityStreams, prepareDataForLLM } from "../services/utils";
import type { StreamSet } from "../types/strava/IStream";
import { gptMiniModel, invokeStructured } from "./model";
import { venuePromptBlock } from "./running_venues";
export type WorkoutAnalysisOutput = z.infer<typeof workoutAnalysisOutput>;

export const workoutStep = z.object({
  reps: z.number().describe("How many times this specific step is repeated within the set/series."),
  work_type: z.enum(["DISTANCE", "TIME"]),
  work_value: z.number().describe("The duration (seconds) or distance (meters)."),
  recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
  recovery_value: z
    .number()
    .nullable()
    .optional()
    .describe("Rest after each rep in this step (seconds or meters)."),
});

export const workoutSet = z.object({
  set_reps: z
    .number()
    .describe(
      "How many times the sequence of steps is repeated. Default to 1 if not a repeating series.",
    ),
  steps: z.array(workoutStep).describe("The individual work segments within this set."),
  set_recovery: z
    .number()
    .nullable()
    .optional()
    .describe(
      "The rest Period between sets, could be TIME or DISTANCE value, could be same as between reps",
    ),
});

export const workoutAnalysisOutput = z.object({
  classification_reasoning: z
    .string()
    .describe(
      "Reason BEFORE classifying. State the single WORK-REP unit: duration in seconds and/or distance in meters PER ONE REP (the leading number is the rep COUNT, never the duration). Then apply the hard gate: a rep >= 120s OR >= 800m is LONG_INTERVALS; a rep < 120s AND < 800m is SHORT_INTERVALS. Example: '6x6min = 6 reps of 360s each; 360 >= 120 -> LONG_INTERVALS'.",
    ),
  training_type: z
    .enum(trainingTypeEnum.enumValues)
    .describe("The classified type of training based on pace and heart rate patterns."),
  confidence_score: z
    .number()
    .min(0)
    .max(1)
    .describe("How certain the model is about this classification."),
  intervals_description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "If intervals are detected, describe them (e.g. '6x800m @ 3:45 pace with 90s rest'). Omit for steady runs.",
    ),
  structure: z
    .array(workoutSet)
    .nullable()
    .optional()
    .describe(
      "A list of workout sets. 10x1000m is one set with one step. 3x(3km,2km,1km) is one set with three steps and 3 set_reps.",
    ),
});

const CLASSIFICATION_RULES = `
- **LONG**: Total distance is > 20 km (running) or equivalent endurance session in another sport. Pace is generally steady or easy.
- **EASY**: Steady aerobic effort, no structured intervals. Covers both true low-intensity recovery-pace work and standard daily Zone 2/3 sessions. Distance <= 20 km for running.
- **RECOVERY**: Cross-training (elliptical, cycling, etc.) used as active recovery, not containing intervals.
- **SHORT_INTERVALS**: Structured work/rest periods where each work interval is short — < 800m AND < 2 minutes duration (e.g. 10x400m, 8x60s).
- **LONG_INTERVALS**: Structured work/rest periods where each work interval is long — >= 800m OR >= 2 minutes duration (e.g. 6x6min, 5x1000m, 4x2000m). A time-based rep of 2 minutes or more is ALWAYS long intervals, regardless of distance.
- **HILL_SPRINTS**: Short intervals (< 300m) with significant elevation gain during the work period.
- **SPRINTS**: Very short duration (< 30s), maximum effort (Max Speed/Anaerobic).
- **FARTLEK**: "Speed play." A mix of various interval lengths/intensities with NO clear repeating structure (e.g., random surges). Do NOT select this just because pace is messy; requires distinct high-effort surges.
- **PROGRESSIVE_LONG**: Distance > 15km. Pace strictly increases (gets faster) from start to finish.
- **TEMPO**: Sustained high effort (Threshold pace) for a block of time (e.g., 20-40 mins).
- **RACE**: Sustained maximal effort for the distance.

### SHORT_INTERVALS vs LONG_INTERVALS — HARD GATE (apply literally, do not eyeball)
Compute the size of ONE work rep (NOT the whole session, NOT the number of reps):
- rep_duration >= 120s  OR  rep_distance >= 800m  ->  LONG_INTERVALS
- rep_duration <  120s  AND rep_distance <  800m  ->  SHORT_INTERVALS
The leading number in a title is the rep COUNT, never the duration. "6x6min" = 6 reps of 360s each; 360 >= 120 -> LONG_INTERVALS.

| Title | Per-rep | Type |
|---|---|---|
| 6x6min | 360s | LONG_INTERVALS |
| 5x1000m | 1000m | LONG_INTERVALS |
| 4x2000m | 2000m | LONG_INTERVALS |
| 8x2min | 120s | LONG_INTERVALS |
| 10x400m | 400m (~80s) | SHORT_INTERVALS |
| 20x45/15 | 45s | SHORT_INTERVALS |
| 15x90/30s | 90s | SHORT_INTERVALS |
`;

function formatIntervalsIcuBlock(prediction: IntervalsIcuPrediction | null | undefined): string {
  if (!prediction) return "";
  const intervals = Array.isArray(prediction.intervals) ? prediction.intervals : [];
  const rows = intervals
    .map((i, idx) => {
      const speedMs =
        i.average_speed != null
          ? i.average_speed
          : i.moving_time > 0
            ? i.distance / i.moving_time
            : null;
      const pace = speedMs != null ? `${speedMs.toFixed(2)} m/s` : "-";
      const hr = i.average_heartrate != null ? `${Math.round(i.average_heartrate)} bpm` : "-";
      const load = i.training_load != null ? `${i.training_load.toFixed(1)}` : "-";
      return `| ${idx + 1} | ${i.type} | ${i.distance}m | ${i.moving_time}s | ${pace} | ${hr} | ${load} |`;
    })
    .join("\n");
  const typeHint = prediction.trainingType
    ? `intervals.icu suggests training type: **${prediction.trainingType}**${prediction.subType ? ` (sub: ${prediction.subType})` : ""}.`
    : "";
  const tableBlock = rows
    ? `\n| # | Type | Distance | Time | Avg pace | Avg HR | Load |\n|---|------|----------|------|----------|--------|------|\n${rows}`
    : "";
  return `\n  ### INTERVALS.ICU PREDICTION (treat as a strong hint, not ground truth)\n  ${typeHint}${tableBlock}\n`;
}

/**
 * Deterministic guardrail: reconcile SHORT_INTERVALS vs LONG_INTERVALS against the
 * model's OWN extracted structure. gpt-4o-mini reliably parses the per-rep value
 * into `work_value` but occasionally flips the gate inequality (observed: "7x4min
 * = 240s each; 240 < 120 -> SHORT"). A rep >= 120 s OR >= 800 m makes it LONG;
 * all reps shorter make it SHORT. Only touches the two interval subtypes.
 */
export function reconcileIntervalSubtype(
  out: z.infer<typeof workoutAnalysisOutput>,
): z.infer<typeof workoutAnalysisOutput> {
  if (out.training_type !== "SHORT_INTERVALS" && out.training_type !== "LONG_INTERVALS") return out;
  const structure = out.structure;
  if (!structure || structure.length === 0) return out;
  let sawRep = false;
  let hasLongRep = false;
  for (const set of structure) {
    for (const step of set.steps) {
      sawRep = true;
      if (step.work_type === "DISTANCE" ? step.work_value >= 800 : step.work_value >= 120) {
        hasLongRep = true;
      }
    }
  }
  if (!sawRep) return out;
  const correct = hasLongRep ? "LONG_INTERVALS" : "SHORT_INTERVALS";
  return correct === out.training_type ? out : { ...out, training_type: correct };
}

export async function invokeActivityAnalysisAgent(
  streams: StreamSet,
  title: string,
  description: string,
  totalElevationGain: number,
  type: string,
  intervalsIcuPrediction?: IntervalsIcuPrediction | null,
  model: ChatOpenAI = gptMiniModel,
): Promise<WorkoutAnalysisOutput | null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ?? [],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data,
  );

  const summary = prepareDataForLLM(normalized, 30);
  const hasHr = summary.metadata.avgHeartRate !== null;
  const tableHeader = hasHr
    ? `| Time | Pace (min/km) | HR | Moving% |\n  |------|--------------|----|---------|`
    : `| Time | Pace (min/km) | Moving% |\n  |------|--------------|---------|`;
  const tableRows = summary.buckets
    .map((b) =>
      hasHr
        ? `| ${b.time} | ${b.pace} | ${b.avgHr ?? "-"} | ${b.isMoving} |`
        : `| ${b.time} | ${b.pace} | ${b.isMoving} |`,
    )
    .join("\n");
  const intervalsIcuBlock = formatIntervalsIcuBlock(intervalsIcuPrediction);
  const prompt = `
  You are an expert running coach analyzing Strava activity data.

  ### 1. PRIORITY & CONTEXT
  - **Title/Description Priority:** You must prioritize the user's Title and Description over raw data IF the user explicitly names the workout (e.g., "10x400m", "Tempo Run", "Long Run").
  - **Ignore Generics:** If the title is generic (e.g., "Morning Run", "Lunch Run", "Run"), ignore it and rely 100% on the data stats.
  - **Fartlek Warning:** Do not default to "Fartlek" just because the data is noisy. Fartlek requires distinct, intentional surges in pace that don't fit a fixed grid. If it's just a steady run with bad GPS data, classify as EASY.

  ### 2. CLASSIFICATION DEFINITIONS
  Use these strict definitions:
  ${CLASSIFICATION_RULES}

  ### 3. ACTIVITY DATA
  - **User Title:** "${title}"
  - **User Description:** "${description}"
  - Activity type: ${type}

  **Aggregated Stats:**
  - Duration: ${(summary.metadata.totalTime / 60).toFixed(1)} minutes
  - Total Distance: ${(summary.metadata.totalDistance / 1000).toFixed(2)} km
  ${summary.metadata.avgHeartRate !== null ? `- Avg HR: ${Math.round(summary.metadata.avgHeartRate)} bpm` : "- Heart-rate data not available for this user"}
  - Total Elevation gained: ${totalElevationGain}

  **Sampled Data (30s Windows):**
  ${tableHeader}
  ${tableRows}
${intervalsIcuBlock}
  ### 4. STRUCTURE EXTRACTION RULES (Hierarchical)
  You must populate the 'structure' array (an array of Sets) using these rules:
  
  1. **Identify Repeating Series:** - For a simple workout like **10x1000m**: Create one Set with **set_reps: 1** and one Step with **reps: 10**.
     - For a complex workout like **3x (3km + 2km + 1km)**: Create one Set with **set_reps: 3**. Inside that set, create three Steps (3000m, 2000m, 1000m) each with **reps: 1**.
  2. **Handle Set Recovery:** If there is a distinct longer break between large sets (e.g., 5 mins between blocks of intervals), put that in **set_recovery**.
  3. **Ignore Warmup/Cooldown:** Only capture the "work" segments.
  4. **Units:** Always convert distance to METERS and time to SECONDS.
  5. **Comma-separated values are a STEP LIST, not decimals (Norwegian list notation):** "3,2,1 km" = three Steps of 3 km, 2 km, 1 km (→ 3000m, 2000m, 1000m); "2 x 3,2,2 km" = one Set with **set_reps: 2** and three Steps (3000m, 2000m, 2000m). A comma between numbers in such a list is a SEPARATOR, never a decimal point.
  6. **"N x (a, b, c)" = N SETS of the sequence a→b→c.** Set **set_reps: N** and create ONE Step per item (reps: 1 each), so the sequence repeats a,b,c / a,b,c / … — e.g. **"5 x (3,2,1 min)"** = set_reps: 5, Steps [180s, 120s, 60s] each reps: 1; **"3x (3km + 2km + 1km)"** = set_reps: 3, Steps [3000m, 2000m, 1000m]. **Do NOT** create 3 Steps with reps: N (that wrongly groups all the a's, then all the b's, then all the c's).
  7. **Compound / sequential workouts = ONE Set PER BLOCK — capture EVERY block.** When the title chains distinct interval blocks, emit a SEPARATE Set for each block in order, and never drop the trailing block(s). Triggers include English "X followed by Y", "X then Y", and Norwegian "X etterfulgt av Y", "X deretter Y", "X så Y", or a top-level "X + Y" joining two different rep schemes. E.g. **"4x1000m etterfulgt av 20x45/15"** = TWO Sets: Set 1 (set_reps: 1, one Step reps: 4, DISTANCE 1000m) and Set 2 (set_reps: 1, one Step reps: 20, TIME 45s work / 15s recovery). (Distinguish from rule 6's "N x (a,b,c)", which is ONE block repeated.)

  ${venuePromptBlock()}

  ### 5. TASK
  First fill 'classification_reasoning': state the per-rep work duration (s) and/or distance (m) for ONE rep, then apply the SHORT vs LONG hard gate. Then classify the run and populate the structure according to the rules above.
`;
  const result = await invokeStructured(workoutAnalysisOutput, prompt, "analyze activity", model);
  return result ? reconcileIntervalSubtype(result) : result;
}
