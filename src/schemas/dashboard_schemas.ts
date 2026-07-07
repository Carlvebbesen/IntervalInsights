import "zod-openapi/extend";
import { z } from "zod";
import { trainingTypeEnum } from "../schema/enums";
import { isoDate } from "./common_schemas";

export const DashboardResponseSchema = z
  .object({
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
  })
  .openapi({ ref: "DashboardResponse" });

const TodaySessionSchema = z
  .object({
    sportType: z.string(),
    trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
    movingTime: z.number().nullable(),
    load: z.number().nullable(),
  })
  .openapi({ ref: "TodaySession" });

const TrainingSummaryDataSchema = z
  .object({
    date: z.string(),
    trainedToday: z.boolean(),
    todaySessions: z.array(TodaySessionSchema),
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
  })
  .openapi({ ref: "TrainingSummaryData" });

export const TrainingSummaryResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: TrainingSummaryDataSchema }),
    z.object({ status: z.literal("not_linked"), data: z.null() }),
    z.object({ status: z.literal("no_recent_data"), data: z.null() }),
  ])
  .openapi({ ref: "TrainingSummaryResponse" });

export const MAX_WELLNESS_RANGE_DAYS = 366;

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

export const TrainingSummaryQuerySchema = z.object({
  date: isoDate.optional(),
});

// ─── Fitness view (flat CTL/ATL/TSB/HRV/sleep series + per-day detail) ─────────

const FitnessPointSchema = z
  .object({
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
  })
  .openapi({ ref: "FitnessPoint" });

export const FitnessSeriesResponseSchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      data: z.object({
        range: z.object({ oldest: z.string(), newest: z.string() }),
        points: z.array(FitnessPointSchema),
      }),
    }),
    z.object({ status: z.literal("not_linked"), data: z.null() }),
    z.object({ status: z.literal("no_data"), data: z.null() }),
  ])
  .openapi({ ref: "FitnessSeriesResponse" });

export const FitnessDayParamSchema = z.object({ date: isoDate });

const FitnessDayActivitySchema = z
  .object({
    id: z.number(),
    title: z.string(),
    sportType: z.string(),
    trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
    distance: z.number(),
    movingTime: z.number(),
    averageHeartRate: z.number().nullable(),
    trainingLoad: z.number().nullable(),
    icuTrainingLoad: z.number().nullable(),
  })
  .openapi({ ref: "FitnessDayActivity" });

// NOTE: bare object (NOT status-wrapped) — the frontend FitnessDayDetail.fromJson
// reads date/fitness/activities at the top level. `fitness` is null when
// intervals.icu isn't linked or has no wellness record for that day.
export const FitnessDayResponseSchema = z
  .object({
    date: z.string(),
    fitness: FitnessPointSchema.nullable(),
    activities: z.array(FitnessDayActivitySchema),
  })
  .openapi({ ref: "FitnessDayResponse" });

export const WeekDetailResponseSchema = z
  .object({
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
  })
  .openapi({ ref: "WeekDetailResponse" });

const PaceSetSchema = z
  .object({
    easySecPerKm: z.number().nullable(),
    thresholdSecPerKm: z.number().nullable(),
    intervalSecPerKm: z.number().nullable(),
    repSecPerKm: z.number().nullable(),
  })
  .openapi({ ref: "PaceSet" });

const PredictedRaceSchema = z
  .object({
    distanceM: z.number(),
    timeSec: z.number(),
    heatDeltaSec: z.number().optional(),
  })
  .openapi({ ref: "PredictedRace" });

const HeatAdjustmentSchema = z
  .object({
    dewPointC: z.number(),
    hasSun: z.boolean(),
    perZoneDeltaSecPerKm: z.object({
      easy: z.number(),
      threshold: z.number(),
      interval: z.number(),
      rep: z.number(),
    }),
    advisory: z.string(),
  })
  .openapi({ ref: "HeatAdjustment" });

const PaceAnchorDataSchema = z
  .object({
    anchorSource: z.enum(["critical_speed", "vdot", "none"]),
    confidence: z.enum(["high", "medium", "low"]),
    criticalSpeedMps: z.number().nullable(),
    dPrimeM: z.number().nullable(),
    vdot: z.number().nullable(),
    paces: PaceSetSchema,
    predictedRaces: z.array(PredictedRaceSchema),
    heat: HeatAdjustmentSchema.nullable().optional(),
  })
  .openapi({ ref: "PaceAnchorData" });

// Optional weather passed as query params on GET /dashboard/pace-anchor.
export const PaceAnchorQuerySchema = z
  .object({
    temperatureC: z.coerce.number().optional(),
    humidity: z.coerce.number().optional(),
    uvIndex: z.coerce.number().optional(),
    cloudCover: z.coerce.number().optional(),
    apparentTemperatureC: z.coerce.number().optional(),
  })
  .openapi({ ref: "PaceAnchorQuery" });

export const PaceAnchorResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: PaceAnchorDataSchema }),
    z.object({ status: z.literal("not_linked"), data: z.null() }),
  ])
  .openapi({ ref: "PaceAnchorResponse" });

// ─── Heart-rate analysis (POST /api/heart-rate/analysis) ──────────────────────
// Contract: docs/backend/heart_rate_analysis_contract.md in the app repo. The
// app sends a partial body (omitted field = no constraint).

export const HeartRateAnalysisRequestSchema = z
  .object({
    trainingType: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
    signatures: z.array(z.string()).optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    intervalsOnly: z.boolean().optional(),
  })
  .openapi({ ref: "HeartRateAnalysisRequest" });

export const HrAnalysisPointSchema = z
  .object({
    activityId: z.number().int(),
    date: z.string(),
    name: z.string(),
    trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
    avgHr: z.number().nullable(),
    maxHr: z.number().nullable(),
    medianHr: z.number().nullable(),
    modeHr: z.number().nullable(),
  })
  .openapi({ ref: "HrAnalysisPoint" });

export const HrZoneSchema = z
  .object({
    label: z.string(),
    min: z.number(),
    max: z.number(),
    color: z.string(),
  })
  .openapi({ ref: "HrZone" });

const HrMetricExtremeSchema = z
  .object({
    activityId: z.number().int(),
    value: z.number(),
  })
  .openapi({ ref: "HrMetricExtreme" });

export const HrMetricSummarySchema = z
  .object({
    min: HrMetricExtremeSchema.nullable(),
    max: HrMetricExtremeSchema.nullable(),
    mean: z.number().nullable(),
  })
  .openapi({ ref: "HrMetricSummary" });

// NOTE: for status:"ok" the parser reads points/zones/summaries from the TOP
// LEVEL alongside status — they are NOT nested under a `data` envelope (unlike
// the wellness/fitness series). `summaries` is keyed by metric api-key.
export const HeartRateAnalysisResponseSchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      points: z.array(HrAnalysisPointSchema),
      zones: z.array(HrZoneSchema),
      summaries: z.record(z.string(), HrMetricSummarySchema),
    }),
    z.object({ status: z.literal("no_data") }),
    z.object({ status: z.literal("not_linked") }),
  ])
  .openapi({ ref: "HeartRateAnalysisResponse" });
