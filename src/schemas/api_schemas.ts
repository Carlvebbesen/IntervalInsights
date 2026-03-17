import { z } from "zod";
import { trainingTypeEnum, analysisStatusEnum, workoutPartEnum, targetTypeEnum } from "../schema/enums";

export const ErrorSchema = z.object({ error: z.string() });

export const ActivitySchema = z.object({
  id: z.number(),
  userId: z.string(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
  intervalStructureId: z.number().nullable(),
  analyzedAt: z.string().nullable(),
  analysisStatus: z.enum(analysisStatusEnum.enumValues).nullable(),
  draftAnalysisResult: z.unknown().nullable(),
  analysisVersion: z.string().nullable(),
  stravaActivityId: z.number(),
  gearId: z.string().nullable(),
  hasHeartrate: z.boolean().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  sportType: z.string(),
  deviceName: z.string().nullable(),
  distance: z.number(),
  movingTime: z.number(),
  elapsedTime: z.number(),
  totalElevationGain: z.number().nullable(),
  averageSpeed: z.number().nullable(),
  averageHeartRate: z.number().nullable(),
  maxHeartRate: z.number().nullable(),
  startDateLocal: z.string(),
  feeling: z.number().nullable(),
  notes: z.string().nullable(),
  gearName: z.string().nullable(),
  createdAt: z.string().nullable(),
  averageTmp: z.number().nullable(),
  indoor: z.boolean(),
});

export const ActivityListResponseSchema = z.object({
  data: z.array(ActivitySchema),
  meta: z.object({
    page: z.number(),
    pageSize: z.number(),
    filterApplied: z.object({
      search: z.string().optional(),
      trainingType: z.enum(trainingTypeEnum.enumValues).optional(),
      distance: z.number().optional(),
    }),
  }),
});

export const IntervalSegmentSchema = z.object({
  id: z.number(),
  activityId: z.number(),
  segmentIndex: z.number(),
  setGroupIndex: z.number(),
  type: z.enum(workoutPartEnum.enumValues),
  targetValue: z.number(),
  targetType: z.enum(targetTypeEnum.enumValues),
  targetPace: z.number().nullable(),
  timeSeriesEndTime: z.number(),
  actualDistance: z.number(),
  actualDuration: z.number(),
  actualPace: z.number(),
  avgHeartRate: z.number().nullable(),
  maxHeartRate: z.number().nullable(),
  medianHeartRate: z.number().nullable(),
});

export const IntervalStructureSchema = z.object({
  id: z.number(),
  name: z.string(),
  signature: z.string().nullable(),
});

export const DashboardResponseSchema = z.object({
  summary: z.object({
    thisWeekKm: z.number(),
    prevWeekKm: z.number(),
    last7DaysKm: z.number(),
    prev7DaysKm: z.number(),
    weekPercentChange: z.number(),
    sevenDayPercentChange: z.number(),
    weightedWeekPercentChange: z.number(),
    weekProgressFraction: z.number(),
    avgKmByThisPointInWeek: z.number(),
    thisWeekElevationGain: z.number(),
    thisWeekMovingTimeSec: z.number(),
    thisWeekAvgHeartRate: z.number().nullable(),
  }),
  graph: z.array(z.object({
    date: z.string(),
    runKm: z.number(),
    otherKm: z.number(),
    otherBreakdown: z.record(z.string(), z.number()),
    totalKm: z.number(),
  })),
  averages: z.object({
    avgSessionsPerWeek: z.number(),
    avgIntervalsPerWeek: z.number(),
    avgFeelingWeek: z.number().nullable(),
    avgFeelingMonth: z.number().nullable(),
    avgElevationPerRun: z.number().nullable(),
    avgDistancePerRunKm: z.number().nullable(),
  }),
});

export const WeekDetailResponseSchema = z.object({
  weekStart: z.string(),
  running: z.object({
    totalKm: z.number(),
    totalElevationGain: z.number(),
    totalMovingTimeSec: z.number(),
    avgHeartRate: z.number().nullable(),
    avgPaceMinPerKm: z.number().nullable(),
    numSessions: z.number(),
    indoorSessions: z.number(),
    outdoorSessions: z.number(),
    avgFeeling: z.number().nullable(),
    percentChangeVsPrevWeek: z.number().nullable(),
    percentChangeVsSameWeek1MonthAgo: z.number().nullable(),
    prevWeekKm: z.number(),
    monthAgoWeekKm: z.number(),
    trainingTypeBreakdown: z.record(z.string(), z.number()),
  }),
  intervals: z.object({ count: z.number() }),
  otherActivities: z.object({
    combinedKm: z.number(),
    breakdown: z.array(z.object({
      sportType: z.string(),
      km: z.number(),
      movingTimeSec: z.number(),
    })),
  }),
});

export const PendingActivitySchema = z.object({
  id: z.number(),
  stravaId: z.number(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
  analysisStatus: z.enum(analysisStatusEnum.enumValues).nullable(),
  draftAnalysisResult: z.unknown().nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  distance: z.number(),
  movingTime: z.number(),
  description: z.string().nullable(),
  indoor: z.boolean(),
});
