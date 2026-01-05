import { z } from "zod";
import { trainingTypeEnum } from "../schema";
import { normalizeActivityStreams, prepareDataForLLM } from "../services.ts/utils";
import { StreamSet } from "../types/strava/IStream";
import { geminiFlashModel } from "./model";
export type WorkoutAnalysisOutput = z.infer<typeof workoutAnalysisOutput>;

export const workoutStep = z.object({
  reps: z.number()
    .describe("How many times this specific step is repeated within the set/series."),
  work_type: z.enum(["DISTANCE", "TIME"]),
  work_value: z.number()
    .describe("The duration (seconds) or distance (meters)."),
  recovery_type: z.enum(["DISTANCE", "TIME"]).optional(),
  recovery_value: z.number().optional()
    .describe("Rest after each rep in this step (seconds or meters)."),
});

export const workoutSet = z.object({
  set_reps: z.number()
    .describe("How many times the sequence of steps is repeated. Default to 1 if not a repeating series."),
  steps: z.array(workoutStep)
    .describe("The individual work segments within this set."),
  set_recovery: z.number().optional()
    .describe("The rest Period between sets, could be TIME or DISTANCE value, could be same as between reps"),
});

export const workoutAnalysisOutput = z.object({
  training_type: z
    .enum(trainingTypeEnum.enumValues)
    .describe("The classified type of training based on pace and heart rate patterns."),
  confidence_score: z.number().min(0).max(1)
    .describe("How certain the model is about this classification."),
  intervals_description: z.string()
    .optional()
    .describe("If intervals are detected, describe them (e.g. '6x800m @ 3:45 pace with 90s rest'). Omit for steady runs."),
  structure: z.array(workoutSet)
    .optional()
    .describe("A list of workout sets. 10x1000m is one set with one step. 3x(3km,2km,1km) is one set with three steps and 3 set_reps."),
});

const CLASSIFICATION_RULES = `
- **LONG_RUN**: Total distance is > 20 km. Pace is generally steady or easy.
- **EASY_RUN**: Total distance is <= 20 km. Low intensity, steady pace.
- **RECOVERY**: IF the activty is elliptical or cycling activity not containing intervals.
- **NORMAL_RUN**: Distance <= 20 km. Standard steady aerobic effort (Zone 2/3). Faster than an easy run, but not a hard workout. The "default" daily run.
- **SHORT_INTERVALS**: Structured work/rest periods. Work intervals are < 800m OR < 2 minutes duration.
- **LONG_INTERVALS**: Structured work/rest periods. Work intervals are >= 800m.
- **HILL_SPRINTS**: Short intervals (< 300m) with significant elevation gain during the work period.
- **SPRINTS**: Very short duration (< 30s), maximum effort (Max Speed/Anaerobic).
- **FARTLEK**: "Speed play." A mix of various interval lengths/intensities with NO clear repeating structure (e.g., random surges). Do NOT select this just because pace is messy; requires distinct high-effort surges.
- **PROGRESSIVE_LONG_RUN**: Distance > 15km. Pace strictly increases (gets faster) from start to finish.
- **TEMPO**: Sustained high effort (Threshold pace) for a block of time (e.g., 20-40 mins).
- **RACE**: Sustained maximal effort for the distance.
`;

export async function invokeActivityAnalysisAgent(
  streams: StreamSet,
  title: string, 
  description: string,
  totalElevationGain: number,
  type: string,
): Promise<WorkoutAnalysisOutput|null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ??[],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data
  );
  
  const summary = prepareDataForLLM(normalized, 30);
  const prompt = `
  You are an expert running coach analyzing Strava activity data.
  
  ### 1. PRIORITY & CONTEXT
  - **Title/Description Priority:** You must prioritize the user's Title and Description over raw data IF the user explicitly names the workout (e.g., "10x400m", "Tempo Run", "Long Run"). 
  - **Ignore Generics:** If the title is generic (e.g., "Morning Run", "Lunch Run", "Run"), ignore it and rely 100% on the data stats.
  - **Fartlek Warning:** Do not default to "Fartlek" just because the data is noisy. Fartlek requires distinct, intentional surges in pace that don't fit a fixed grid. If it's just a steady run with bad GPS data, classify as EASY_RUN.

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
  - Avg HR: ${Math.round(summary.metadata.avgHeartRate)} bpm
  - Total Elevation gained: ${totalElevationGain}
  
  **Sampled Data (30s Windows):**
  | Time | Pace (min/km) | HR | Moving% |
  |------|--------------|----|---------|
  ${summary.buckets.map(b => `| ${b.time} | ${b.pace} | ${b.avgHr} | ${b.isMoving} |`).join('\n')}
  
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
  try {
    const result = await geminiFlashModel
      .withStructuredOutput(workoutAnalysisOutput)
      .invoke(
        prompt
      );
    return result;
  } catch (error) {
    console.error("Failed to analyze activity:", error);
    return null;
  }
}