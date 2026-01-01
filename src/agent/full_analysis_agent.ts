import z from "zod";
import { StreamSet } from "../types/strava/IStream";
import { normalizeActivityStreams, prepareDataForLLM } from "../services.ts/utils";
import { WorkoutAnalysisOutput } from "./initial_analysis_agent";
import { Lap } from "../types/strava/IDetailedActivity";
import { geminiFlashModel } from "./model";
import { targetTypeEnum, TrainingType, workoutPartEnum, WorkoutPartType } from "../schema";

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
      .describe("Extract the target pace exactly as written (e.g. '3:45'). Omit if not mentioned."),
  })),
});



export async function invokeCompleteActivityAnalysisAgent(
  streams: StreamSet,
  comment: string,
  trainingType: TrainingType,
  laps: Lap[],
  initalAgentResult: WorkoutAnalysisOutput|null,
): Promise<SegmentPlanOutput|null> {
  const normalized = normalizeActivityStreams(
    streams?.time?.data ??[],
    streams?.velocity_smooth?.data,
    streams?.heartrate?.data,
    streams?.distance?.data,
    streams?.moving?.data
  );
  let initalAgentPrompt ="";
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

Comment from user: ${comment}

INPUT DATA:
1. **Strava Laps** (User pressed lap button or Autolap):
${laps.map((l, i) => `Lap ${i}: ${l.distance}m in ${l.elapsed_time}s avg speed: ${l.average_speed}`).join('\n')}

2. **Sampled Data (30s Windows):**
  | Time | Pace (min/km) | HR | Moving% |
  |------|--------------|----|---------|
  ${buckets.buckets.map(b => `| ${b.time} | ${b.pace} | ${b.avgHr} | ${b.isMoving} |`).join('\n')}

TASK:
1. **Identify Segments & Boundaries:** - Merge Autolaps if needed (e.g. 1km splits during a 5km tempo -> 1 segment).
   - Trust manual laps if they match the description.

   2. Extract Targets:
   - **Important:** If the target is DISTANCE, convert it to **METERS** (e.g. "1km" -> 1000).
   - If the target is TIME, convert it to **SECONDS**.
   - If the user specifies a pace (e.g. "3:45"), put that string in 'target_pace_string'.
   - If the user specifies increase pace from 4:00 to 3:45 over 4 intervals, the interpolate the pace on the middle ones

   3. **Handle Series (Sets):**
   - If the workout is "2 sets of 4x400m", assign 'set_group_index: 1' to the first 4 intervals, and 'set_group_index: 2' to the next 4.
   - The Rest interval *between* sets usually belongs to the previous set or is neutral.

4. **Extract Conditional Targets:**
   - Look closely at the description.
   - Example: "First 4 at 3:45, last 4 at 3:30".
   - You must assign '3:45' to ACTIVE segments 1,2,3,4 and '3:30' to ACTIVE segments 5,6,7,8.
   - If the user says "Recoveries were 90s", ensure the REST segments have a target_value of 90 (TIME).

RETURN only the structured plan.
`;
  try {
    const result = await geminiFlashModel
      .withStructuredOutput(segmentPlanOutput)
      .invoke(
        prompt
      );
    return result;
  } catch (error) {
    console.error("Failed to analyze activity:", error);
    return null;
  }
}