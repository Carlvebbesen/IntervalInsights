import { z } from "zod";
import {
  analysisStatusEnum,
  eventStatusEnum,
  eventTypeEnum,
  targetTypeEnum,
  trainingTypeEnum,
  workoutPartEnum,
} from "../schema/enums";

export const ActivityEventSchema = z.object({
  id: z.number(),
  eventType: z.enum(eventTypeEnum.enumValues),
  bodyLocation: z.string().nullable(),
  description: z.string(),
  startTime: z.string(),
  lastOccurrence: z.string(),
  status: z.enum(eventStatusEnum.enumValues),
  resolvedAt: z.string().nullable(),
});

export const EventListItemSchema = ActivityEventSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const EventListResponseSchema = z.object({
  events: z.array(EventListItemSchema),
});

export const DeleteEventResponseSchema = z.object({
  unlinked: z.boolean(),
  deleted: z.boolean(),
});

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
  intervalsIcuId: z.string().nullable().optional(),
  intervalsAnalyzed: z.boolean().nullable().optional(),
  intervalsIcuEnrichedAt: z.string().nullable().optional(),
  elapsedTime: z.number().nullable().optional(),
  maxHeartRate: z.number().nullable().optional(),
  averagePower: z.number().nullable().optional(),
  weightedAveragePower: z.number().nullable().optional(),
  calories: z.number().nullable().optional(),
  deviceName: z.string().nullable().optional(),
  trainingLoad: z.number().nullable().optional(),
  icuTrainingLoad: z.number().nullable().optional(),
  icuIntensity: z.number().nullable().optional(),
  relativeIntensity: z.number().nullable().optional(),
  decoupling: z.number().nullable().optional(),
  polarizationIndex: z.number().nullable().optional(),
  icuFtp: z.number().nullable().optional(),
  icuCtl: z.number().nullable().optional(),
  icuAtl: z.number().nullable().optional(),
  events: z.array(ActivityEventSchema).optional(),
});

export const ActivityListItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  startDateLocal: z.string(),
  distance: z.number(),
  sportType: z.string(),
  indoor: z.boolean(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
  trainingLoad: z.number().nullable(),
  icuTrainingLoad: z.number().nullable(),
  averageHeartRate: z.number().nullable(),
});

export const ActivityListResponseSchema = z.object({
  data: z.array(ActivityListItemSchema),
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
      eventTypes: z.array(z.enum(eventTypeEnum.enumValues)).optional(),
      eventIds: z.array(z.number().int().positive()).optional(),
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

const TrainingSummaryDataSchema = z.object({
  date: z.string(),
  fitness: z.object({
    ctl: z.number().nullable(),
    atl: z.number().nullable(),
    rampRate: z.number().nullable(),
    ctlLoad: z.number().nullable(),
    atlLoad: z.number().nullable(),
  }),
  sleep: z.object({
    sleepSecs: z.number().nullable(),
    sleepScore: z.number().nullable(),
  }),
  recovery: z.object({
    restingHR: z.number().nullable(),
    hrv: z.number().nullable(),
    readiness: z.number().nullable(),
    baevskySI: z.number().nullable(),
    spO2: z.number().nullable(),
    respiration: z.number().nullable(),
  }),
  body: z.object({
    weight: z.number().nullable(),
    vo2max: z.number().nullable(),
  }),
});

export const TrainingSummaryResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: TrainingSummaryDataSchema }),
  z.object({ status: z.literal("not_linked"), data: z.null() }),
  z.object({ status: z.literal("no_recent_data"), data: z.null() }),
]);

export const MAX_WELLNESS_RANGE_DAYS = 366;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");

export const WellnessQuerySchema = z
  .object({ oldest: isoDate, newest: isoDate })
  .refine(({ oldest, newest }) => oldest <= newest, {
    message: "`oldest` must be on or before `newest`",
    path: ["newest"],
  })
  .refine(
    ({ oldest, newest }) => {
      const days = Math.floor((Date.parse(newest) - Date.parse(oldest)) / 86_400_000) + 1;
      return days <= MAX_WELLNESS_RANGE_DAYS;
    },
    {
      message: `Range too large (max ${MAX_WELLNESS_RANGE_DAYS} days)`,
      path: ["newest"],
    },
  );

const MetricStatsSchema = z.object({
  latest: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
});

const WellnessSeriesPointSchema = z.object({
  date: z.string(),
  fitness: z.object({
    ctl: z.number().nullable(),
    atl: z.number().nullable(),
    tsb: z.number().nullable(),
    rampRate: z.number().nullable(),
    ctlLoad: z.number().nullable(),
    atlLoad: z.number().nullable(),
  }),
  sleep: z.object({
    sleepSecs: z.number().nullable(),
    sleepScore: z.number().nullable(),
    sleepQuality: z.number().nullable(),
  }),
  recovery: z.object({
    restingHR: z.number().nullable(),
    hrv: z.number().nullable(),
    readiness: z.number().nullable(),
    baevskySI: z.number().nullable(),
    spO2: z.number().nullable(),
    respiration: z.number().nullable(),
  }),
  subjective: z.object({
    soreness: z.number().nullable(),
    fatigue: z.number().nullable(),
    stress: z.number().nullable(),
    mood: z.number().nullable(),
    motivation: z.number().nullable(),
  }),
  health: z.object({
    injury: z.number().nullable(),
    sickness: z.number().nullable(),
  }),
  body: z.object({
    weight: z.number().nullable(),
    bodyFat: z.number().nullable(),
    vo2max: z.number().nullable(),
  }),
  comments: z.string().nullable(),
});

const WellnessSeriesDataSchema = z.object({
  range: z.object({ oldest: z.string(), newest: z.string() }),
  metricsAvailable: z.array(z.string()),
  summary: z.record(z.string(), MetricStatsSchema),
  points: z.array(WellnessSeriesPointSchema),
});

export const WellnessSeriesResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: WellnessSeriesDataSchema }),
  z.object({ status: z.literal("not_linked"), data: z.null() }),
  z.object({ status: z.literal("no_data"), data: z.null() }),
]);

// ─── Fitness view (flat CTL/ATL/TSB/HRV/sleep series + per-day detail) ─────────

const FitnessPointSchema = z.object({
  date: z.string(),
  ctl: z.number().nullable(),
  atl: z.number().nullable(),
  tsb: z.number().nullable(),
  ctlLoad: z.number().nullable(),
  atlLoad: z.number().nullable(),
  hrv: z.number().nullable(),
  hrv7dAvg: z.number().nullable(),
  hrvStatus: z.enum(["balanced", "unbalanced", "low"]).nullable(),
  hrvNightlyStatus: z.enum(["balanced", "unbalanced", "low"]).nullable(),
  // Personal baseline band (mean ± 1 SD) for shading the "balanced" zone behind
  // the HRV line. Null when there's insufficient history for a baseline.
  hrvBaseline: z
    .object({
      mean: z.number(),
      lowerBalanced: z.number(),
      upperBalanced: z.number(),
    })
    .nullable(),
  sleepScore: z.number().nullable(),
});

export const FitnessSeriesResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    data: z.object({
      range: z.object({ oldest: z.string(), newest: z.string() }),
      points: z.array(FitnessPointSchema),
    }),
  }),
  z.object({ status: z.literal("not_linked"), data: z.null() }),
  z.object({ status: z.literal("no_data"), data: z.null() }),
]);

export const FitnessDayParamSchema = z.object({ date: isoDate });

const FitnessDayActivitySchema = z.object({
  id: z.number(),
  title: z.string(),
  sportType: z.string(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
  distance: z.number(),
  movingTime: z.number(),
  averageHeartRate: z.number().nullable(),
  trainingLoad: z.number().nullable(),
  icuTrainingLoad: z.number().nullable(),
});

// NOTE: bare object (NOT status-wrapped) — the frontend FitnessDayDetail.fromJson
// reads date/fitness/activities at the top level. `fitness` is null when
// intervals.icu isn't linked or has no wellness record for that day.
export const FitnessDayResponseSchema = z.object({
  date: z.string(),
  fitness: FitnessPointSchema.nullable(),
  activities: z.array(FitnessDayActivitySchema),
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
  wellness: z
    .object({
      avgSleepScore: z.number().nullable(),
      avgFatigue: z.number().nullable(),
      fitness: z.number().nullable(),
      form: z.number().nullable(),
      totalLoad: z.number().nullable(),
    })
    .nullable(),
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
