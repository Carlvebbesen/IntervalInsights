import { eq,and,desc } from "drizzle-orm";
import { invokeActivityAnalysisAgent, WorkoutAnalysisOutput, workoutSet } from "../agent/initial_analysis_agent";
import {
  activities,
  findOrCreateIntervalStructure,
  generateIntervalSignature,
  getDbInsertIntervalSegmentsFromStravaMetrics,
  intervalSegments,
  intervalStructures,
  mapSetsToIntervalComponent,
} from "../schema";
import { IGlobalBindings } from "../types/IRouters";
import { DetailedActivity, Lap } from "../types/strava/IDetailedActivity";
import { stravaApiService } from "./strava_api_service";
import { invokeCompleteActivityAnalysisAgent } from "../agent/full_analysis_agent";
import { calculateSegmentStats, couldSkipCompleteAnalysis, generateCompleteIntervalSet, needCompleteAnalysis, parsePaceStringToMetersPerSecond } from "./utils";
import z from "zod";
import { sleep } from "bun";
import { ExpandedIntervalSet, } from "../types/ExpandedIntervalSet";

export const triggerInitialAnalysis = async (
  db: IGlobalBindings["db"],
  accessToken: string,
  stravaId: number,
  index: number,
  stravaActivity?: DetailedActivity,
  isRetry?: boolean,
):Promise<WorkoutAnalysisOutput|null> => {
  if (index > 0) {
    await sleep(index * 5000); 
  }
  try {
    let currentStravaActivity = stravaActivity;
    if (!currentStravaActivity) {
      currentStravaActivity = await stravaApiService.getActivity(
        accessToken,
        stravaId
      );
    }
    const streams = await stravaApiService.getActivityStreams(
      accessToken,
      stravaId,
      ["time","velocity_smooth","heartrate","distance","moving"]
    );

    if (!streams || Object.keys(streams).length === 0) {
      console.warn(
        `No streams returned for activity ${stravaId}. Analysis may be limited.`
      );
      return null;
    }
    const [{activityId}] = await db
      .update(activities)
      .set({ analysisStatus: "ongoing_init" })
      .where(eq(activities.stravaActivityId, currentStravaActivity.id)).returning({activityId:activities.id});
    const analysisResult = await invokeActivityAnalysisAgent(
      streams,
      currentStravaActivity.name,
      currentStravaActivity.description ?? "-",
      currentStravaActivity.total_elevation_gain,
      currentStravaActivity.type,
    );
    if (analysisResult) {
      const baseUpdate = {
        analyzedAt: new Date(),
        analysisStatus: "initial" as const,
        draftAnalysisResult: analysisResult,
        analysisVersion : "v2.0",
      };
      const couldSkip = couldSkipCompleteAnalysis(analysisResult);
      const finalUpdateObject = couldSkip
        ? {
            ...baseUpdate,
            trainingType: analysisResult.training_type,
            analysisStatus: "completed" as const,
          }
        : baseUpdate;
      await db
        .update(activities)
        .set(finalUpdateObject)
        .where(eq(activities.id, activityId));
      if (couldSkip) {
        await setStravaMetricsAsIntervalSegments(
          db,
          "",
          activityId,stravaId,
          accessToken
        );
      }
      return analysisResult;
    }
    await db.update(activities).set({ analysisStatus: "pending" }).where(eq(activities.id, activityId));
    return null;
  } catch (error:any) {
    const errorMessage = error?.message || "";
    const isRateLimit = error?.status === 429 || errorMessage.includes("429");

    if (isRateLimit && !isRetry) {
      let waitMs = 10000;
      const retryMatch = errorMessage.match(/retry in ([\d.]+)s/);
      if (retryMatch && retryMatch[1]) {
        waitMs = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 2000; 
      } else if (error?.retryDelay) {
        waitMs = parseInt(error.retryDelay) * 1000 + 2000;
      }
      console.warn(`Quota exceeded for ${stravaId}. Waiting ${waitMs}ms before one-time retry.`);
      await db.update(activities)
        .set({ analysisStatus: "pending" })
        .where(eq(activities.stravaActivityId, stravaId));
      await sleep(waitMs);
      return triggerInitialAnalysis(db, accessToken, stravaId, 0,stravaActivity, true);
    }
    
    console.error(
      `Error in triggerAnalysis for activity ${stravaId}:`,
      error
    );
    try {
    await db
      .update(activities)
      .set({ analysisStatus: "error" })
      .where(eq(activities.stravaActivityId, stravaId));
  } catch (dbError) {
    console.error("Could not even set error status in DB:", dbError);
  }
  return null;
  }
};

export const triggerCompleteAnalysis = async (
  db: IGlobalBindings["db"],
  accessToken: string,
  activityId: number,
  stravaId: number,
  notes: string,
  sets: ExpandedIntervalSet[]
) => {
  try {
    const result = await db.query.activities.findFirst({where:
      eq(activities.id, activityId),
      columns: {
        draftAnalysisResult: true,
        trainingType: true,
      }
    })
    if (!result) {
      throw new Error("Failed to retrieve activity");
    }
    if (!result.trainingType) {
      throw new Error(
        "The activity needs to have a trainingType before running complete analysis"
      );
    }
    if (!needCompleteAnalysis(result.trainingType)) {
      return await setStravaMetricsAsIntervalSegments(
        db,
        notes,
        activityId,
        stravaId,
        accessToken
      );
    }
const streams = await stravaApiService.getActivityStreams(
  accessToken,
  stravaId,
  ["time","velocity_smooth","heartrate","distance","moving"]
);
    const laps = await stravaApiService.getActivityLaps(
      accessToken,
      stravaId
    );
    if (!streams || Object.keys(streams).length === 0) {
      console.warn(
        `No streams returned for activity ${activityId}. Analysis may be limited.`
      );
      return null;
    }
    await db
      .update(activities)
      .set({ analysisStatus: "ongoing_completed" })
      .where(eq(activities.id, activityId));
    const analysisResult = await invokeCompleteActivityAnalysisAgent(
      streams,
      notes,
      result.trainingType,
      laps,
      result.draftAnalysisResult,
      sets,
    );
    if (analysisResult) {
      let segmentIndexCounter = 0;
      const finalSegments = analysisResult.segments
        .map((seg) => {
          const stats = calculateSegmentStats(
            streams,
            seg.start_time,
            seg.end_time
          );

          if (!stats) return null;
          const numericTargetPace = parsePaceStringToMetersPerSecond(
            seg.target_pace_string ?? ""
          );
          return {
            activityId: activityId,
            segmentIndex: segmentIndexCounter++,
            setGroupIndex: seg.set_group_index ?? 0,
            type: seg.type,
            targetType: seg.target_type,
            targetValue: seg.target_value,
            targetPace: numericTargetPace,
            timeSeriesEndTime: stats.timeSeriesEndTime,
            actualDistance: stats.actualDistance,
            actualDuration: stats.actualDuration,
            actualPace: stats.actualPace,
            avgHeartRate: stats.avgHeartRate,
            maxHeartRate: stats.maxHeartRate,
            medianHeartRate: stats.medianHeartRate,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      const intervalStructure = await findOrCreateIntervalStructure(db, finalSegments, result.trainingType)
      const updateActivityObject = {
        intervalStructureId: intervalStructure.id,
        trainingType:result.trainingType,
        analysisStatus: "completed" as const,
        analysedAt: new Date(),
        notes: notes,
      };
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(activities)
            .set(updateActivityObject)
            .where(eq(activities.id, activityId));
          await tx
            .delete(intervalSegments)
            .where(eq(intervalSegments.activityId, activityId));
          if (finalSegments.length > 0) {
            await tx.insert(intervalSegments).values(finalSegments);
          }
        });

        console.log(
          `Successfully updated activity ${activityId} with ${finalSegments.length} segments.`
        );
        return analysisResult;
      } catch (error) {
        console.error("DB Update Failed:", error);
        throw error; // Re-throw to handle in UI
      }
    }
  } catch (error) {
    await db
      .update(activities)
      .set({ analysisStatus: "error" })
      .where(eq(activities.id, activityId));
    console.error(
      `Error in triggerAnalysis for activity ${activityId}:`,
      error
    );
    return null;
  }
};

const setStravaMetricsAsIntervalSegments = async (
  db: IGlobalBindings["db"],
  notes: string,
  activityId: number,
  stravaId: number,
  accessToken: string
) => {
  await db
    .update(activities)
    .set({
      analysisStatus: "completed",
      notes: notes,
    })
    .where(eq(activities.id, activityId));
  const stravaActivity = await stravaApiService.getActivity(
    accessToken,
    stravaId
  );
  const splits = stravaActivity.splits_metric ??[];
  if (splits.length > 0) {
    await db
      .insert(intervalSegments)
      .values(
        getDbInsertIntervalSegmentsFromStravaMetrics(
          activityId,
          splits ??[]
        )
      );
  }
};


export const getProposedPaceForStructure = async (
  db: IGlobalBindings["db"],
  userId: string, 
  sets: z.infer<typeof workoutSet>[],
):Promise<ExpandedIntervalSet[]> => {
  const components = mapSetsToIntervalComponent(sets);
  const signature = generateIntervalSignature(components);
  const completeIntervalSet = generateCompleteIntervalSet(sets)
  const historyByStructure = await db
    .select({
      targetValue: intervalSegments.targetValue,
      targetType: intervalSegments.targetType,
      actualPace: intervalSegments.actualPace,
      targetPace: intervalSegments.targetPace,
      segmentIndex: intervalSegments.segmentIndex,
      date: activities.startDateLocal, 
    })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .innerJoin(intervalSegments, eq(intervalSegments.activityId, activities.id))
    .where(and(
      eq(activities.userId, userId),
      eq(intervalStructures.signature, signature),
      eq(intervalSegments.type, "INTERVALS")
    ))
    .orderBy(desc(activities.startDateLocal))
    .limit(10);
  if (historyByStructure.length > 0) {
    return calculateAverages(historyByStructure, completeIntervalSet);
  }
  return completeIntervalSet;
};
function calculateAverages(
  rows: { 
    targetValue: number; 
    targetType: string; 
    actualPace: number; 
    targetPace: number | null; 
    segmentIndex: number;
    date: Date 
  }[],
  sets: ExpandedIntervalSet[]
): ExpandedIntervalSet[] {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = new Date().getTime();
  const getEffectivePace = (row: typeof rows[0]) => row.targetPace ?? row.actualPace;
  const sortedRows = [...rows].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const averagePace = sortedRows.length > 0
    ? sortedRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / sortedRows.length
    : null;
  let workIntervalCounter = 0;
  
  return sets.map((set) => ({
    ...set,
    steps: set.steps.map((step) => {
      const currentIntervalNumber = workIntervalCounter++;
      const targetType = step.work_type === "DISTANCE" ? "distance" : "time";
      const targetVal = step.work_value;
      
      let relevantRow = sortedRows[currentIntervalNumber];
      if (relevantRow && 
          relevantRow.targetType === targetType && 
          Math.abs(relevantRow.targetValue - targetVal) < 1) {
      } else {
        const matchingRows = sortedRows.filter(row => 
          row.targetType === targetType && 
          Math.abs(row.targetValue - targetVal) < 1
        );
        
        if (matchingRows.length > 0) {
          console.log("FALLBACK: Using average of matching rows", currentIntervalNumber);
          const avgPaceForMatching = matchingRows.reduce((sum, row) => 
            sum + getEffectivePace(row), 0
          ) / matchingRows.length;
          
          return {
            ...step,
            target_pace: avgPaceForMatching,
          };
        } else {
          return {
            ...step,
            target_pace: averagePace,
          };
        }
      }
      
      if (!relevantRow) {
        return { ...step, target_pace: averagePace };
      }
      
      const msSinceLastDone = now - relevantRow.date.getTime();
      
      let proposedPace: number;
      if (msSinceLastDone < ONE_MONTH_MS) {
        proposedPace = getEffectivePace(relevantRow);
      } else {
        const matchingRows = sortedRows.filter(row => 
          row.targetType === relevantRow.targetType && 
          Math.abs(row.targetValue - relevantRow.targetValue) < 1
        );
        
        if (matchingRows.length > 0) {
          proposedPace = matchingRows.reduce((sum, row) => 
            sum + getEffectivePace(row), 0
          ) / matchingRows.length;
        } else {
          proposedPace = averagePace ?? getEffectivePace(relevantRow);
        }
      }

      return {
        ...step,
        target_pace: proposedPace,
      };
    })
  }));
}