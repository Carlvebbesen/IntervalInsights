import z from "zod";
import {
  type TrainingType,
  targetTypeEnum,
  type WorkoutPartType,
  workoutPartEnum,
} from "../schema";
import {
  formatRawPaceFromMps,
  normalizeActivityStreams,
  prepareDataForLLM,
} from "../services/utils";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import type { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { invokeStructured } from "./model";
export type SegmentPlanOutput = z.infer<typeof segmentPlanOutput>;

type ValidWorkoutPart = Exclude<WorkoutPartType, "JOGGING">;
export const segmentPlanOutput = z.object({
  segments: z.array(
    z.object({
      type: z.enum(
        workoutPartEnum.enumValues.filter((part) => part !== "JOGGING") as [
          ValidWorkoutPart,
          ...ValidWorkoutPart[],
        ],
      ),
      start_time: z.number().describe("Start time in seconds from activity start"),
      end_time: z.number().describe("End time in seconds"),
      set_group_index: z
        .number()
        .nullable()
        .optional()
        .describe("1-based index. Use this to group sets. Omit if not applicable."),
      target_type: z.enum(targetTypeEnum.enumValues),
      target_value: z
        .number()
        .describe(
          "Primary target value. IF DISTANCE: Must be in METERS. IF TIME: Must be in SECONDS.",
        ),
      target_pace_string: z
        .string()
        .nullable()
        .optional()
        .describe("The target pace for this segment. Format: 'M:SS'"),
    }),
  ),
});

export async function invokeCompleteActivityAnalysisAgent(
  streams: StreamSet,
  comment: string,
  trainingType: TrainingType,
  laps: Lap[],
  initalAgentResult: WorkoutAnalysisOutput | null,
  groups: ExpandedIntervalSet[],
): Promise<SegmentPlanOutput | null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ?? [],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data,
  );

  const specificIntervalPaces = groups
    .flatMap((group, setIndex) => {
      const setHeader = `### SET ${setIndex + 1} (Recovery between sets: ${group.set_recovery ?? "N/A"}s)`;
      const stepStrings = group.steps.map((step, stepIndex) => {
        const readablePace = step.target_pace
          ? formatRawPaceFromMps(Number(step.target_pace))
          : "No target found";

        const target =
          step.work_type === "DISTANCE" ? `${step.work_value}m` : `${step.work_value}s`;

        return `- Interval ${stepIndex + 1}: Target ${target} at Pace **${readablePace}** (Rest: ${step.recovery_value}s)`;
      });

      return [setHeader, ...stepStrings, ""];
    })
    .join("\n");
  let initalAgentPrompt = "";
  if (initalAgentResult != null) {
    const { confidence_score, intervals_description } = initalAgentResult;
    initalAgentPrompt = `Context: The previous agent identified this activity as:
  - Classification Confidence: ${(confidence_score * 100).toFixed(0)}%
  - Description: ${intervals_description ?? "N/A"}
  `;
  }

  const buckets = prepareDataForLLM(normalized, 30);
  const hasHr = buckets.metadata.avgHeartRate !== null;
  const tableHeader = hasHr
    ? `| Time | Pace (min/km) | HR | Moving% |\n  |------|--------------|----|---------|`
    : `| Time | Pace (min/km) | Moving% |\n  |------|--------------|---------|`;
  const tableRows = buckets.buckets
    .map((b) =>
      hasHr
        ? `| ${b.time} | ${b.pace} | ${b.avgHr ?? "-"} | ${b.isMoving} |`
        : `| ${b.time} | ${b.pace} | ${b.isMoving} |`,
    )
    .join("\n");

  const userPacesBlock =
    specificIntervalPaces.trim().length > 0
      ? `### USER-SPECIFIED TARGET PACES (MANDATORY):
Below is the exact sequence of work intervals and their expected paces, grouped by Sets.
Match these to the pace/HR surges in the data:
${specificIntervalPaces}`
      : `### USER-SPECIFIED TARGET PACES:
The user did not provide explicit target paces. Detect work/rest segments from the pace and HR data alone.`;

  const prompt = `
You are a Data Segmentation Agent.
The trainingType, confirmed by the user is: ${trainingType}
${initalAgentPrompt}

${userPacesBlock}

Comment from user: ${comment}

INPUT DATA:
1. **Strava Laps**:
${laps.map((l, i) => `Lap ${i}: ${l.distance}m in ${l.elapsed_time}s avg speed: ${l.average_speed}`).join("\n")}

2. **Sampled Data (30s Windows):**
  ${tableHeader}
  ${tableRows}

TASK:
1. **Set Grouping:** Use 'set_group_index' (1-based) to group segments in the same Set (e.g., all 10 intervals in Set 1 get set_group_index: 1).
2. **Sequential Matching:** Match the identified "WORK" segments to the USER-SPECIFIED TARGET PACES list in chronological order.
3. **Pace Assignment:** For each "WORK" segment, set 'target_pace_string' exactly as provided (e.g., "3:45"). If no user paces were given, omit it.
4. **Segment Types (use these enum values EXACTLY):**
   - "WARMUP" for the initial steady period.
   - "INTERVALS" for each work interval (this is the value for what is sometimes called "WORK"). MUST be used for every work rep.
   - "REST" for short recovery periods between reps within a set.
   - "ACTIVE_REST" for the longer recovery between sets (only if the structure has multiple sets).
   - "COOL_DOWN" for the final steady period (note the underscore — NOT "COOLDOWN").
5. **Output Format:** Return the segments with correct start/end times, target types, and target paces.

RETURN only the structured plan.
`;

  return invokeStructured(segmentPlanOutput, prompt, "analyze activity");
}
