import { z } from "zod";
import {
  analysisStatusEnum,
  targetTypeEnum,
  trainingTypeEnum,
  workoutPartEnum,
} from "../schema/enums";

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
  distance: z.number(),
  movingTime: z.number(),
  totalElevationGain: z.number().nullable(),
  averageHeartRate: z.number().nullable(),
  startDateLocal: z.string(),
  feeling: z.number().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().nullable(),
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
      intervalStructureId: z.number().optional(),
      sportTypes: z.array(z.string()).optional(),
      signatures: z.array(z.string()).optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
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
  avgHeartRate: z.number().nullable(),
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
    avgKmByThisPointInWeek: z.number(),
    thisWeekElevationGain: z.number(),
    thisWeekMovingTimeSec: z.number(),
    thisWeekAvgHeartRate: z.number().nullable(),
  }),
  graph: z.array(
    z.object({
      date: z.string(),
      runKm: z.number(),
      otherKm: z.number(),
      otherBreakdown: z.record(z.string(), z.number()),
      totalKm: z.number(),
    }),
  ),
  averages: z.object({
    avgSessionsPerWeek: z.number(),
    avgIntervalsPerWeek: z.number(),
    avgFeelingWeek: z.number().nullable(),
    avgFeelingMonth: z.number().nullable(),
    avgElevationPerRun: z.number().nullable(),
    avgDistancePerRunKm: z.number().nullable(),
  }),
  wellness: z
    .object({
      ctl: z.number().nullable(),
      atl: z.number().nullable(),
      tsb: z.number().nullable(),
      avgHrv: z.number().nullable(),
      avgSleepQuality: z.number().nullable(),
      restingHr: z.number().nullable(),
    })
    .nullable(),
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
    breakdown: z.array(
      z.object({
        sportType: z.string(),
        km: z.number(),
        movingTimeSec: z.number(),
      }),
    ),
  }),
});

export const GearStatsItemSchema = z.object({
  gearId: z.string(),
  gearName: z.string(),
  activityCount: z.number(),
  trainingTypeCounts: z.record(z.string(), z.number()),
  distanceKm: z.number(),
});

export const GearStatsResponseSchema = z.object({ stats: z.array(GearStatsItemSchema) });

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
  feeling: z.number().nullable(),
});

// ─── Strava-shaped schemas (mirror Strava v3 REST shapes for app consumption) ──

export const StravaLapSchema = z.object({
  id: z.number(),
  resource_state: z.number(),
  name: z.string(),
  activity: z.object({ id: z.number(), resource_state: z.number() }),
  athlete: z.object({ id: z.number(), resource_state: z.number() }),
  elapsed_time: z.number(),
  moving_time: z.number(),
  start_date: z.string(),
  start_date_local: z.string(),
  distance: z.number(),
  start_index: z.number(),
  end_index: z.number(),
  total_elevation_gain: z.number(),
  average_speed: z.number(),
  max_speed: z.number(),
  average_cadence: z.number().optional(),
  device_watts: z.boolean().optional(),
  average_watts: z.number().optional(),
  average_heartrate: z.number().optional(),
  max_heartrate: z.number().optional(),
  lap_index: z.number(),
  split: z.number(),
});

export const SplitMetricSchema = z.object({
  distance: z.number(),
  elapsed_time: z.number(),
  elevation_difference: z.number(),
  moving_time: z.number(),
  split: z.number(),
  average_speed: z.number(),
  average_grade_adjusted_speed: z.number().optional(),
  average_heartrate: z.number().optional(),
  pace_zone: z.number(),
});

// Strava SummaryActivity returned by GET /api/strava/sync/activities. The shape
// is forwarded verbatim from Strava v3, so we mirror the documented fields and
// allow extras via `passthrough()` to stay forward-compatible.
export const StravaSummaryActivitySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    distance: z.number(),
    moving_time: z.number(),
    elapsed_time: z.number(),
    total_elevation_gain: z.number(),
    type: z.string(),
    sport_type: z.string(),
    start_date: z.string(),
    start_date_local: z.string(),
    timezone: z.string(),
    utc_offset: z.number(),
    trainer: z.boolean(),
    commute: z.boolean(),
    manual: z.boolean(),
    private: z.boolean(),
    average_speed: z.number(),
    max_speed: z.number(),
    has_heartrate: z.boolean(),
    average_heartrate: z.number().optional(),
    max_heartrate: z.number().optional(),
    elev_high: z.number().optional(),
    elev_low: z.number().optional(),
    gear_id: z.string().nullable().optional(),
  })
  .passthrough();

export const SyncResultSchema = z.object({
  id: z.number(),
  status: z.enum(["success", "failed"]),
  error: z.unknown().optional(),
});

// ─── Proposed-pace response (POST /api/agents/proposed-pace) ──────────────────

export const ExpandedIntervalStepSchema = z.object({
  work_type: z.enum(["DISTANCE", "TIME"]),
  work_value: z.number(),
  recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
  recovery_value: z.number().nullable().optional(),
  target_pace: z.number().nullable(),
});

export const ExpandedIntervalSetSchema = z.object({
  set_recovery: z.number().nullable().optional(),
  steps: z.array(ExpandedIntervalStepSchema),
});

export const ProposedPaceResponseSchema = z.array(ExpandedIntervalSetSchema);
