import { z } from "zod";
import { trainingTypeEnum } from "../schema";
import type { IntervalsIcuPrediction } from "../schema/activities";
import { normalizeActivityStreams, prepareDataForLLM } from "../services.ts/utils";
import type { StreamSet } from "../types/strava/IStream";
import { invokeStructured } from "./model";
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
- **SHORT_INTERVALS**: Structured work/rest periods. Work intervals are < 800m OR < 2 minutes duration.
- **LONG_INTERVALS**: Structured work/rest periods. Work intervals are >= 800m.
- **HILL_SPRINTS**: Short intervals (< 300m) with significant elevation gain during the work period.
- **SPRINTS**: Very short duration (< 30s), maximum effort (Max Speed/Anaerobic).
- **FARTLEK**: "Speed play." A mix of various interval lengths/intensities with NO clear repeating structure (e.g., random surges). Do NOT select this just because pace is messy; requires distinct high-effort surges.
- **PROGRESSIVE_LONG**: Distance > 15km. Pace strictly increases (gets faster) from start to finish.
- **TEMPO**: Sustained high effort (Threshold pace) for a block of time (e.g., 20-40 mins).
- **RACE**: Sustained maximal effort for the distance.
`;

function formatIntervalsIcuBlock(prediction: IntervalsIcuPrediction | null | undefined): string {
  if (!prediction) return "";
  const rows = (prediction.intervals ?? [])
    .map((i, idx) => {
      const pace = i.avg_pace != null ? `${i.avg_pace.toFixed(2)} m/s` : "-";
      const hr = i.avg_hr != null ? `${Math.round(i.avg_hr)} bpm` : "-";
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

export async function invokeActivityAnalysisAgent(
  streams: StreamSet,
  title: string,
  description: string,
  totalElevationGain: number,
  type: string,
  intervalsIcuPrediction?: IntervalsIcuPrediction | null,
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
     - For a complex workout like **3x (3km + 2km + 1km)**: Create one Set with **set_reps: 3''. Inside that set, create three Steps (3000m, 2000m, 1000m) each with **reps: 1**.
  2. **Handle Set Recovery:** If there is a distinct longer break between large sets (e.g., 5 mins between blocks of intervals), put that in **set_recovery**.
  3. **Ignore Warmup/Cooldown:** Only capture the "work" segments.
  4. **Units:** Always convert distance to METERS and time to SECONDS.

  ### 5. TASK
  Analyze the data and classify the run according to the rules above.
`;
  return invokeStructured(workoutAnalysisOutput, prompt, "analyze activity");
}
