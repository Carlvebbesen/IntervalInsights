import z from "zod";
import { StreamSet } from "../types/strava/IStream";
import { formatRawPaceFromMps, normalizeActivityStreams, prepareDataForLLM } from "../services.ts/utils";
import { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { Lap } from "../types/strava/IDetailedActivity";
import { geminiFlashModel } from "./model";
import { targetTypeEnum, TrainingType, workoutPartEnum, WorkoutPartType } from "../schema";
import { IntervalGroup } from "../types/IintervalGroup";
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
  groups: IntervalGroup[]
): Promise<SegmentPlanOutput | null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ?? [],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data
  );

const specificIntervalPaces = groups.flatMap((group) => {
  const firstItem = group.items[0];
  const groupTarget = firstItem 
    ? `${firstItem.targetValue}${firstItem.unit.toLowerCase()}` 
    : 'Unknown';
  const groupHeader = `Intervals with same target: ${groupTarget}, rest in this group:${group.restValue}`;
  const intervalStrings = group.items.map((item, index) => {
    const readablePace = formatRawPaceFromMps(item.proposedPace ?? 0);
    const target = `${item.targetValue}${item.unit.toLowerCase()}`;
    return `- Interval ${index + 1} with Target ${target} at Pace **${readablePace}**`;
  });
  return [groupHeader, ...intervalStrings];
}).join('\n');
  let initalAgentPrompt = "";
  if (initalAgentResult != null) {
    const { confidence_score, intervals_description, structure } = initalAgentResult;
    const structureSummary = structure
      ? structure.map((block, index) => {
        const typeLabel = block.work_type === 'DISTANCE' ? 'm' : 's';
        const restLabel = block.recovery_value ? `with ${block.recovery_value}s rest` : 'continuous';
        return `   - Block ${index + 1}: ${block.reps} x ${block.work_value}${typeLabel} (${restLabel})`;
      }).join('\n')
      : "   - No specific structure detected.";
    initalAgentPrompt = `Context: The previous agent identified this activity as:
  - Classification Confidence: ${(confidence_score * 100).toFixed(0)}%
  - Description: ${intervals_description ?? "N/A"}
  
  - Detected Structure (Blocks):
${structureSummary}`;
  }

  const buckets = prepareDataForLLM(normalized, 30);
  
  const prompt = `
You are a Data Segmentation Agent.
The trainingType, confirmed by the user is: ${trainingType}
${initalAgentPrompt}

### USER-SPECIFIED TARGET PACES (MANDATORY):
The user has provided specific target paces for each individual interval in the sequence. 
Match these to the "WORK" segments you identify in the data:
${specificIntervalPaces}


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