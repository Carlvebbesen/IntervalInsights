import z from "zod";
import { StreamSet } from "../types/strava/IStream";
import { formatRawPaceFromMps, normalizeActivityStreams, prepareDataForLLM } from "../services.ts/utils";
import { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { Lap } from "../types/strava/IDetailedActivity";
import { geminiFlashModel } from "./model";
import { targetTypeEnum, TrainingType, workoutPartEnum, WorkoutPartType } from "../schema";
import { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
export type SegmentPlanOutput = z.infer<typeof segmentPlanOutput>;

type ValidWorkoutPart = Exclude<WorkoutPartType, "JOGGING">;
export const segmentPlanOutput = z.object({
  segments: z.array(z.object({
    type: z.enum(workoutPartEnum.enumValues.filter((part) => part !== "JOGGING") as [ValidWorkoutPart, ...ValidWorkoutPart[]]),
    start_time: z.number().describe("Start time in seconds from activity start"),
    end_time: z.number().describe("End time in seconds"),
    set_group_index: z.number().optional()
      .describe("1-based index. Use this to group sets. Omit if not applicable."),
    target_type: z.enum(targetTypeEnum.enumValues),
    target_value: z.number()
      .describe("Primary target value. IF DISTANCE: Must be in METERS. IF TIME: Must be in SECONDS."),
    target_pace_string: z.string().optional()
      .describe("The target pace for this segment. Format: 'M:SS'"),
  })),
});

export async function invokeCompleteActivityAnalysisAgent(
  streams: StreamSet,
  comment: string,
  trainingType: TrainingType,
  laps: Lap[],
  initalAgentResult: WorkoutAnalysisOutput | null,
  groups: ExpandedIntervalSet[]
): Promise<SegmentPlanOutput | null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ?? [],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data
  );

const specificIntervalPaces = groups.flatMap((group, setIndex) => {
  const setHeader = `### SET ${setIndex + 1} (Recovery between sets: ${group.set_recovery ?? 'N/A'}s)`;
  const stepStrings = group.steps.map((step, stepIndex) => {
    const readablePace = step.target_pace 
      ? formatRawPaceFromMps(Number(step.target_pace)) 
      : "No target found";
      
    const target = step.work_type === "DISTANCE" 
      ? `${step.work_value}m` 
      : `${step.work_value}s`;

    return `- Interval ${stepIndex + 1}: Target ${target} at Pace **${readablePace}** (Rest: ${step.recovery_value}s)`;
  });

  return [setHeader, ...stepStrings, ""];
}).join('\n');
  let initalAgentPrompt = "";
  if (initalAgentResult != null) {
    const { confidence_score, intervals_description} = initalAgentResult;
    initalAgentPrompt = `Context: The previous agent identified this activity as:
  - Classification Confidence: ${(confidence_score * 100).toFixed(0)}%
  - Description: ${intervals_description ?? "N/A"}
  `;
  }

  const buckets = prepareDataForLLM(normalized, 30);
  
  const prompt = `
You are a Data Segmentation Agent.
The trainingType, confirmed by the user is: ${trainingType}
${initalAgentPrompt}

### USER-SPECIFIED TARGET PACES (MANDATORY):
Below is the exact sequence of work intervals and their expected paces, grouped by Sets.
Match these to the pace/HR surges in the data:
${specificIntervalPaces}

TASK:
1. **Set Grouping:** Use the 'set_group_index' (1-based) to group segments belonging to the same Set (e.g., all 10 intervals in Set 1 get set_group_index: 1).
2. **Sequential Matching:** Match the identified "WORK" segments in the data to the list above in chronological order.
3. **Pace Assignment:** For each "WORK" segment, set the 'target_pace_string' exactly as provided (e.g., "3:45").
4. **Segment Types:** - Use "WARMUP" for the initial steady period.
   - Use "WORK" for the intervals listed above.
   - Use "REST" for the recovery periods between intervals.
   - Use "COOLDOWN" for the final steady period.### USER-SPECIFIED TARGET PACES (MANDATORY):
Below is the exact sequence of work intervals and their expected paces, grouped by Sets.
Match these to the pace/HR surges in the data:
${specificIntervalPaces}

TASK:
1. **Set Grouping:** Use the 'set_group_index' (1-based) to group segments belonging to the same Set (e.g., all 10 intervals in Set 1 get set_group_index: 1).
2. **Sequential Matching:** Match the identified "WORK" segments in the data to the list above in chronological order.
3. **Pace Assignment:** For each "WORK" segment, set the 'target_pace_string' exactly as provided (e.g., "3:45").
4. **Segment Types:**
   - Use "WARMUP" for the initial steady period.
   - Use "WORK" for the intervals listed above.
   - Use "REST" for the recovery periods between intervals.
   - Use "COOLDOWN" for the final steady period.

Comment from user: ${comment}

INPUT DATA:
1. **Strava Laps**:
${laps.map((l, i) => `Lap ${i}: ${l.distance}m in ${l.elapsed_time}s avg speed: ${l.average_speed}`).join('\n')}

2. **Sampled Data (30s Windows):**
  | Time | Pace (min/km) | HR | Moving% |
  |------|--------------|----|---------|
  ${buckets.buckets.map(b => `| ${b.time} | ${b.pace} | ${b.avgHr} | ${b.isMoving} |`).join('\n')}

TASK:
1. **Sequential Matching:** Match the identified Work segments to the "USER-SPECIFIED TARGET PACES" list in order. 
2. **Apply Paces:** For each identified Work segment, set the 'target_pace_string' exactly as provided in the list above (e.g., "3:45").
3. **Handle Transitions:** Use the Recovery guidance to set the 'target_value' for REST segments.
4. **Output Format:** Return the segments with correct start/end times, target types, and the specific target paces.

RETURN only the structured plan.
`;

  try {
    const result = await geminiFlashModel
      .withStructuredOutput(segmentPlanOutput)
      .invoke(prompt);
    return result;
  } catch (error) {
    console.error("Failed to analyze activity:", error);
    return null;
  }
}