import { eq,and,desc, sql } from "drizzle-orm";
import { invokeActivityAnalysisAgent, workoutBlock } from "../agent/initial_analysis_agent";
import {
  activities,
  findOrCreateIntervalStructure,
  generateIntervalSignature,
  getDbInsertIntervalSegmentsFromStravaMetrics,
  intervalSegments,
  intervalStructures,
  mapBlocksToComponents,
  normalize,
} from "../schema";
import { IGlobalBindings } from "../types/IRouters";
import { DetailedActivity } from "../types/strava/IDetailedActivity";
import { stravaApiService } from "./strava_api_service";
import { invokeCompleteActivityAnalysisAgent } from "../agent/full_analysis_agent";
import { calculateSegmentStats, couldSkipCompleteAnalysis, needCompleteAnalysis, parsePaceStringToMetersPerSecond } from "./utils";
import z from "zod";

export const triggerInitialAnalysis = async (
  db: IGlobalBindings["db"],
  accessToken: string,
  stravaId: number,
  stravaActivity?: DetailedActivity
) => {
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
    return null;
  } catch (error) {
    await db
      .update(activities)
      .set({ analysisStatus: "error" })
      .where(eq(activities.stravaActivityId, stravaId));
    console.error(
      `Error in triggerAnalysis for activity ${stravaId}:`,
      error
    );
    return null;
  }
};

export const triggerCompleteAnalysis = async (
  db: IGlobalBindings["db"],
  accessToken: string,
  activityId: number,
  stravaId: number,
  userComment: string
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
        userComment,
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
      userComment,
      result.trainingType,
      laps,
      result.draftAnalysisResult
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
        notes: userComment,
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
  userComment: string,
  activityId: number,
  stravaId: number,
  accessToken: string
) => {
  await db
    .update(activities)
    .set({
      analysisStatus: "completed",
      notes: userComment,
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
  blocks: z.infer<typeof workoutBlock>[]
) => {
  const components = mapBlocksToComponents(blocks);
  const signature = generateIntervalSignature(components);
  const uniqueTargets = new Map<string, { type: 'distance' | 'time', val: number }>();
  
  components.forEach(c => {
    const key = generateIntervalSignature(c);
    uniqueTargets.set(key, { 
      type: c.unit === 'm' || c.unit === 'km' ? 'distance' : 'time',
      val: normalize(c.value, c.unit)
    });
  });
  const historyByStructure = await db
    .select({
      targetValue: intervalSegments.targetValue,
      targetType: intervalSegments.targetType,
      actualPace: intervalSegments.actualPace,
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
    .limit(200);
  if (historyByStructure.length > 0) {
    return calculateAverages(historyByStructure, uniqueTargets);
  }
  const conditions = Array.from(uniqueTargets.values()).map(t => 
    and(
      eq(intervalSegments.targetType, t.type),
      eq(intervalSegments.targetValue, t.val) 
    )
  );

  if (conditions.length === 0) return null;

  const historyByComponent = await db
    .select({
      targetValue: intervalSegments.targetValue,
      targetType: intervalSegments.targetType,
      actualPace: intervalSegments.actualPace,
    })
    .from(intervalSegments)
    .innerJoin(activities, eq(activities.id, intervalSegments.activityId))
    .where(and(
      eq(activities.userId, userId),
      eq(intervalSegments.type, "INTERVALS"),
      sql`(${sql.join(conditions, sql` OR `)})`
    ))
    .orderBy(desc(activities.startDateLocal))
    .limit(100);

  if (historyByComponent.length > 0) {
    return calculateAverages(historyByComponent, uniqueTargets);
  }

  return null;
};

function calculateAverages(
  rows: { targetValue: number; targetType: string; actualPace: number }[],
  targets: Map<string, { type: string; val: number }>
) {
  const result: Record<string, number> = {};

  targets.forEach((meta, key) => {
    const relevantRows = rows.filter(r => 
      r.targetType === meta.type && 
      Math.abs(r.targetValue - meta.val) < 1
    );

    if (relevantRows.length === 0) return;
    const totalSpeed = relevantRows.reduce((sum, r) => sum + r.actualPace, 0);
    const avgSpeed = totalSpeed / relevantRows.length;

    result[key] = avgSpeed; 
  });

  return Object.keys(result).length > 0 ? result : null;
}

