import "zod-openapi/extend";
import { z } from "zod";
import { workoutSet } from "../agent/initial_analysis_agent";
import {
  analysisStatusEnum,
  eventStatusEnum,
  eventTypeEnum,
  gearSurfaceEnum,
  gearTypeEnum,
  targetTypeEnum,
  trainingBucketEnum,
  trainingTypeEnum,
  userRoleEnum,
  workoutPartEnum,
} from "../schema/enums";

export const ActivityEventSchema = z
  .object({
    id: z.number(),
    eventType: z.enum(eventTypeEnum.enumValues),
    bodyLocation: z.string().nullable(),
    description: z.string(),
    startTime: z.string(),
    lastOccurrence: z.string(),
    status: z.enum(eventStatusEnum.enumValues),
    resolvedAt: z.string().nullable(),
  })
  .openapi({ ref: "ActivityEvent" });

export const EventListItemSchema = ActivityEventSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "EventListItem" });

export const EventListResponseSchema = z
  .object({
    events: z.array(EventListItemSchema),
  })
  .openapi({ ref: "EventListResponse" });

export const DeleteEventResponseSchema = z
  .object({
    unlinked: z.boolean(),
    deleted: z.boolean(),
  })
  .openapi({ ref: "DeleteEventResponse" });

export const ErrorSchema = z.object({ error: z.string() }).openapi({ ref: "Error" });

// Shared weather snapshot (device-sourced, e.g. iOS WeatherKit). temperatureC +
// humidity are what the heat-pace model needs; the rest refine the estimate.
export const WeatherSchema = z
  .object({
    temperatureC: z.number(),
    humidity: z.number().describe("Relative humidity, %."),
    apparentTemperatureC: z.number().optional(),
    uvIndex: z.number().optional(),
    cloudCover: z.number().optional().describe("0..1 fraction."),
    windKph: z.number().optional(),
    condition: z.string().optional(),
  })
  .openapi({ ref: "Weather" });

export type Weather = z.infer<typeof WeatherSchema>;

export const CoachChatRequestSchema = z
  .object({
    conversationId: z
      .string()
      .uuid()
      .describe("Stable id for the conversation thread (persisted)."),
    message: z.string().min(1).max(4000),
    userTime: z.string().describe("Athlete's current local time (ISO 8601)."),
    weather: WeatherSchema.partial().optional(),
  })
  .openapi({ ref: "CoachChatRequest" });

export type CoachChatRequest = z.infer<typeof CoachChatRequestSchema>;

export const ChatConversationSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "ChatConversationSummary" });

export const ChatConversationListSchema = z
  .object({
    data: z.array(ChatConversationSummarySchema),
    meta: z.object({ page: z.number(), pageSize: z.number() }),
  })
  .openapi({ ref: "ChatConversationList" });

export const ExpandedIntervalStepSchema = z
  .object({
    work_type: z.enum(["DISTANCE", "TIME"]),
    work_value: z.number(),
    recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
    recovery_value: z.number().nullable().optional(),
    target_pace: z.number().nullable(),
  })
  .openapi({ ref: "ExpandedIntervalStep" });

export const ExpandedIntervalSetSchema = z
  .object({
    set_recovery: z.number().nullable().optional(),
    steps: z.array(ExpandedIntervalStepSchema),
  })
  .openapi({ ref: "ExpandedIntervalSet" });

export const EditedSegmentSchema = z
  .object({
    type: z.enum(workoutPartEnum.enumValues),
    setGroupIndex: z.number().int().min(0),
    timeSeriesEndTime: z.number().nonnegative(),
  })
  .openapi({ ref: "EditedSegment" });

export const WorkoutStructureStepSchema = z
  .object({
    reps: z.number(),
    work_type: z.enum(["DISTANCE", "TIME"]),
    work_value: z.number(),
    recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
    recovery_value: z.number().nullable().optional(),
    target_pace: z.number().nullable(),
  })
  .openapi({ ref: "WorkoutStructureStep" });

export const WorkoutStructureSetSchema = z
  .object({
    set_reps: z.number(),
    set_recovery: z.number().nullable().optional(),
    steps: z.array(WorkoutStructureStepSchema),
  })
  .openapi({ ref: "WorkoutStructureSet" });

export const ProposedTrainingArtifactSchema = z
  .object({
    type: z.literal("proposed_training"),
    id: z.string(),
    title: z.string(),
    trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
    notes: z.string().nullable().optional(),
    structure: z.array(WorkoutStructureSetSchema),
  })
  .openapi({ ref: "ProposedTrainingArtifact" });

export const ChartArtifactSchema = z
  .object({
    type: z.literal("chart"),
    id: z.string(),
    chartType: z.enum(["line", "bar", "area", "scatter"]),
    title: z.string(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    xType: z.enum(["number", "category", "time"]).optional(),
    series: z.array(
      z.object({
        name: z.string(),
        points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional() })),
      }),
    ),
  })
  .openapi({ ref: "ChartArtifact" });

export const TableArtifactSchema = z
  .object({
    type: z.literal("table"),
    id: z.string(),
    title: z.string().optional(),
    columns: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        align: z.enum(["left", "right", "center"]).optional(),
      }),
    ),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  })
  .openapi({ ref: "TableArtifact" });

export const StatCardsArtifactSchema = z
  .object({
    type: z.literal("stat_cards"),
    id: z.string(),
    title: z.string().optional(),
    cards: z.array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        unit: z.string().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
        hint: z.string().optional(),
      }),
    ),
  })
  .openapi({ ref: "StatCardsArtifact" });

export const WeeklyPlanArtifactSchema = z
  .object({
    type: z.literal("weekly_plan"),
    id: z.string(),
    title: z.string(),
    days: z.array(
      z.object({
        day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
        sessionType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
        title: z.string(),
        description: z.string().optional(),
        isRest: z.boolean().optional(),
      }),
    ),
  })
  .openapi({ ref: "WeeklyPlanArtifact" });

export const CoachArtifactSchema = z
  .discriminatedUnion("type", [
    ProposedTrainingArtifactSchema,
    ChartArtifactSchema,
    TableArtifactSchema,
    StatCardsArtifactSchema,
    WeeklyPlanArtifactSchema,
  ])
  .openapi({ ref: "CoachArtifact" });

export type CoachArtifact = z.infer<typeof CoachArtifactSchema>;

export const ChatMessageSchema = z
  .object({
    id: z.number(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    artifacts: z.array(CoachArtifactSchema).nullish(),
    createdAt: z.string(),
  })
  .openapi({ ref: "ChatMessage" });

export const ChatConversationDetailSchema = ChatConversationSummarySchema.extend({
  messages: z.array(ChatMessageSchema),
}).openapi({ ref: "ChatConversationDetail" });

export const UserSchema = z
  .object({
    id: z.string(),
    clerkId: z.string(),
    stravaId: z.string().nullable(),
    role: z.enum(userRoleEnum.enumValues).nullable(),
    maxHeartRate: z.number().nullable(),
    processHeartRate: z.boolean(),
    privacyPolicyAcceptedAt: z.string().nullable(),
    privacyPolicyVersion: z.string().nullable(),
    currentPrivacyPolicyVersion: z.string(),
    termsOfServiceAcceptedAt: z.string().nullable(),
    termsOfServiceVersion: z.string().nullable(),
    currentTermsOfServiceVersion: z.string(),
  })
  .openapi({ ref: "User" });

export const DeleteAccountResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
  })
  .openapi({ ref: "DeleteAccountResponse" });

export const GearSummarySchema = z
  .object({
    id: z.number(),
    brand: z.string().nullable(),
    model: z.string(),
    nickname: z.string().nullable(),
    displayName: z.string(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    isActive: z.boolean(),
  })
  .openapi({ ref: "GearSummary" });

export const ActivitySchema = z
  .object({
    id: z.number(),
    userId: z.string(),
    trainingType: z.enum(trainingTypeEnum.enumValues).nullable(),
    intervalStructureId: z.number().nullable(),
    analyzedAt: z.string().nullable(),
    analysisStatus: z.enum(analysisStatusEnum.enumValues).nullable(),
    draftAnalysisResult: z.unknown().nullable(),
    analysisVersion: z.string().nullable(),
    stravaActivityId: z.number().nullable(),
    gearId: z.string().nullable(),
    localGearId: z.number().nullable(),
    gear: GearSummarySchema.nullable().optional(),
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
  })
  .openapi({ ref: "Activity" });

export const ActivityListItemSchema = z
  .object({
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
  })
  .openapi({ ref: "ActivityListItem" });

export const ActivityListResponseSchema = z
  .object({
    data: z.array(ActivityListItemSchema),
    meta: z.object({
      page: z.number(),
      pageSize: z.number(),
      filterApplied: z.object({
        search: z.string().optional(),
        trainingType: z.array(z.enum(trainingTypeEnum.enumValues)).optional(),
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
  })
  .openapi({ ref: "ActivityListResponse" });

export const IntervalSegmentSchema = z
  .object({
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
  })
  .openapi({ ref: "IntervalSegment" });

export const ProposedSegmentSchema = z
  .object({
    segmentIndex: z.number(),
    setGroupIndex: z.number(),
    type: z.enum(workoutPartEnum.enumValues),
    timeSeriesEndTime: z.number(),
    actualDistance: z.number().optional(),
    actualDuration: z.number().optional(),
    avgHeartRate: z.number().nullable().optional(),
    targetType: z.enum(targetTypeEnum.enumValues).optional(),
    targetValue: z.number().optional(),
    targetPace: z.number().nullable().optional(),
  })
  .openapi({ ref: "ProposedSegment" });

export const DraftSegmentsResponseSchema = z
  .object({
    proposedSegments: z.array(ProposedSegmentSchema),
    streams: z.object({
      time: z.array(z.number()),
      heartrate: z.array(z.number()).nullable(),
      velocity: z.array(z.number()),
    }),
  })
  .openapi({ ref: "DraftSegmentsResponse" });

export const EditorStreamsSchema = z.object({
  time: z.array(z.number()),
  heartrate: z.array(z.number()).nullable(),
  velocity: z.array(z.number()),
});

/**
 * Editor-state request: pass exactly one of `structure` (initial load → compute paces)
 * or `sets` (re-derive after a structural edit → paces verbatim). `structure` mirrors
 * the `/proposed-pace` body's `structure: workoutSet[]`.
 */
export const EditorStateRequestSchema = z
  .object({
    structure: z.array(workoutSet).optional(),
    sets: z.array(ExpandedIntervalSetSchema).optional(),
    trainingType: z.enum(trainingTypeEnum.enumValues),
    includeStreams: z.boolean().optional(),
  })
  .refine((v) => (v.structure == null) !== (v.sets == null), {
    message: "Provide exactly one of `structure` or `sets`",
  });

/**
 * One call that hydrates BOTH the proposed-pace view and the segment editor from a
 * single source of truth: the paced rep-list (`sets`) drives the derived `segments`,
 * so the two views cannot diverge. Replaces the separate /proposed-pace + /draft-segments
 * round-trips. `streams` is null when `includeStreams: false` (e.g. a re-derive after a
 * structural edit, where the client already holds the streams).
 */
export const EditorStateResponseSchema = z
  .object({
    sets: z.array(ExpandedIntervalSetSchema),
    segments: z.array(ProposedSegmentSchema),
    streams: EditorStreamsSchema.nullable(),
  })
  .openapi({ ref: "EditorStateResponse" });

export const ActivityStreamsSchema = z
  .object({
    time: z.array(z.number()),
    distance: z.array(z.number()),
    heartrate: z.array(z.number()).nullable(),
    altitude: z.array(z.number()).nullable(),
    cadence: z.array(z.number()).nullable(),
    velocity: z.array(z.number()).nullable(),
  })
  .openapi({ ref: "ActivityStreams" });

export const EditSegmentInputSchema = z
  .object({
    type: z.enum(workoutPartEnum.enumValues),
    setGroupIndex: z.number().int().min(0),
    targetType: z.enum(targetTypeEnum.enumValues),
    targetValue: z.number(),
    targetPace: z.number().nullable(),
    timeSeriesEndTime: z.number().nonnegative(),
  })
  .openapi({ ref: "EditSegmentInput" });

export const EditSegmentsRequestSchema = z
  .object({
    segments: z.array(EditSegmentInputSchema).min(1),
  })
  .openapi({ ref: "EditSegmentsRequest" });

export const PatchSegmentSchema = z
  .object({
    type: z.enum(workoutPartEnum.enumValues).optional(),
    setGroupIndex: z.number().int().min(0).optional(),
    targetType: z.enum(targetTypeEnum.enumValues).optional(),
    targetValue: z.number().optional(),
    targetPace: z.number().nullable().optional(),
    timeSeriesEndTime: z.number().nonnegative().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" })
  .openapi({ ref: "PatchSegment" });

export const SegmentsResponseSchema = z
  .object({
    intervalSegments: z.array(IntervalSegmentSchema),
  })
  .openapi({ ref: "SegmentsResponse" });

export const IntervalStructureSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    signature: z.string().nullable(),
  })
  .openapi({ ref: "IntervalStructure" });

export const IntervalStructureListItemSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    signature: z.string().nullable(),
    activityCount: z.number(),
    lastDoneAt: z.string().nullable(),
  })
  .openapi({ ref: "IntervalStructureListItem" });

export const IntervalStructureListResponseSchema = z
  .object({
    data: z.array(IntervalStructureListItemSchema),
    meta: z.object({ count: z.number() }),
  })
  .openapi({ ref: "IntervalStructureListResponse" });

export const IntervalStructureHistoryEntrySchema = z
  .object({
    activityId: z.number(),
    date: z.string(),
    title: z.string(),
    distance: z.number(),
    movingTime: z.number(),
    avgHeartRate: z.number().nullable(),
    load: z.number().nullable(),
    workRepCount: z.number(),
    avgWorkPaceSecPerKm: z.number().nullable(),
    fastestWorkPaceSecPerKm: z.number().nullable(),
    slowestWorkPaceSecPerKm: z.number().nullable(),
    avgWorkHr: z.number().nullable(),
    minWorkHr: z.number().nullable(),
    maxWorkHr: z.number().nullable(),
  })
  .openapi({ ref: "IntervalStructureHistoryEntry" });

export const IntervalStructureHistoryResponseSchema = z
  .object({
    data: z.array(IntervalStructureHistoryEntrySchema),
    meta: z.object({ structureId: z.number(), count: z.number() }),
  })
  .openapi({ ref: "IntervalStructureHistoryResponse" });

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

export const TrainingSummaryQuerySchema = z.object({
  date: isoDate.optional(),
});

const MetricStatsSchema = z
  .object({
    latest: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    avg: z.number().nullable(),
  })
  .openapi({ ref: "MetricStats" });

const WellnessSeriesPointSchema = z
  .object({
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
  })
  .openapi({ ref: "WellnessSeriesPoint" });

const WellnessSeriesDataSchema = z
  .object({
    range: z.object({ oldest: z.string(), newest: z.string() }),
    metricsAvailable: z.array(z.string()),
    summary: z.record(z.string(), MetricStatsSchema),
    points: z.array(WellnessSeriesPointSchema),
  })
  .openapi({ ref: "WellnessSeriesData" });

export const WellnessSeriesResponseSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), data: WellnessSeriesDataSchema }),
    z.object({ status: z.literal("not_linked"), data: z.null() }),
    z.object({ status: z.literal("no_data"), data: z.null() }),
  ])
  .openapi({ ref: "WellnessSeriesResponse" });

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

export const GearStatsItemSchema = z
  .object({
    gearId: z.string(),
    gearName: z.string(),
    activityCount: z.number(),
    trainingTypeCounts: z.record(z.string(), z.number()),
    distanceKm: z.number(),
  })
  .openapi({ ref: "GearStatsItem" });

export const GearStatsResponseSchema = z
  .object({ stats: z.array(GearStatsItemSchema) })
  .openapi({ ref: "GearStatsResponse" });

export const PendingActivitySchema = z
  .object({
    id: z.number(),
    startDateLocal: z.string(),
    stravaId: z.number().nullable(),
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
    sportType: z.string(),
    localGearId: z.number().nullable(),
    suggestedGearId: z.number().nullable(),
    gearSuggestions: z.array(z.number()),
  })
  .openapi({ ref: "PendingActivity" });

// ─── Gear ──────────────────────────────────────────────────────────────────────

export const GearSchema = z
  .object({
    id: z.number(),
    gearType: z.enum(gearTypeEnum.enumValues),
    brand: z.string().nullable(),
    model: z.string(),
    nickname: z.string().nullable(),
    displayName: z.string(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    isActive: z.boolean(),
    retiredAt: z.string().nullable(),
    stravaGearId: z.string().nullable(),
    baselineDistanceMeters: z.number(),
    baselineDate: z.string().nullable(),
    maintainedDistanceMeters: z.number(),
    distanceMeters: z.number(),
    distanceKm: z.number(),
    activityCount: z.number(),
    isDefaultEasy: z.boolean(),
    isDefaultLong: z.boolean(),
    isDefaultIntervals: z.boolean(),
    trainingTypeCounts: z.record(z.string(), z.number()),
    createdAt: z.string().nullable(),
  })
  .openapi({ ref: "Gear" });

export const GearListResponseSchema = z
  .object({ data: z.array(GearSchema) })
  .openapi({ ref: "GearListResponse" });

export const CreateGearSchema = z
  .object({
    brand: z.string().nullable().optional(),
    model: z.string().min(1),
    nickname: z.string().nullable().optional(),
    surface: z.enum(gearSurfaceEnum.enumValues),
    gearType: z.enum(gearTypeEnum.enumValues).optional(),
    defaultEasy: z.boolean().optional(),
    defaultLong: z.boolean().optional(),
    defaultIntervals: z.boolean().optional(),
  })
  .openapi({ ref: "CreateGear" });

export const UpdateGearSchema = z
  .object({
    brand: z.string().nullable().optional(),
    model: z.string().min(1).optional(),
    nickname: z.string().nullable().optional(),
    surface: z.enum(gearSurfaceEnum.enumValues).optional(),
    isActive: z.boolean().optional(),
    defaultEasy: z.boolean().optional(),
    defaultLong: z.boolean().optional(),
    defaultIntervals: z.boolean().optional(),
  })
  .openapi({ ref: "UpdateGear" });

export const GearDefaultSchema = z
  .object({
    bucket: z.enum(trainingBucketEnum.enumValues),
    surface: z.enum(gearSurfaceEnum.enumValues),
    gearId: z.number(),
  })
  .openapi({ ref: "GearDefault" });

export const GearDefaultsResponseSchema = z
  .object({ defaults: z.array(GearDefaultSchema) })
  .openapi({ ref: "GearDefaultsResponse" });

export const SetGearDefaultSchema = z
  .object({
    bucket: z.enum(trainingBucketEnum.enumValues),
    surface: z.enum(gearSurfaceEnum.enumValues),
    gearId: z.number().nullable(),
  })
  .openapi({ ref: "SetGearDefault" });

export const BrandsResponseSchema = z
  .object({ brands: z.array(z.string()) })
  .openapi({ ref: "BrandsResponse" });

export const AssignGearSchema = z
  .object({ gearId: z.number().nullable() })
  .openapi({ ref: "AssignGear" });

export const SyncGearResponseSchema = z
  .object({
    created: z.number(),
    updated: z.number(),
    linked: z.number(),
  })
  .openapi({ ref: "SyncGearResponse" });

// ─── Strava-shaped schemas (mirror Strava v3 REST shapes for app consumption) ──

export const StravaLapSchema = z
  .object({
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
  })
  .openapi({ ref: "StravaLap" });

export const SplitMetricSchema = z
  .object({
    distance: z.number(),
    elapsed_time: z.number(),
    elevation_difference: z.number(),
    moving_time: z.number(),
    split: z.number(),
    average_speed: z.number(),
    average_grade_adjusted_speed: z.number().optional(),
    average_heartrate: z.number().optional(),
    pace_zone: z.number(),
  })
  .openapi({ ref: "SplitMetric" });

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
  .passthrough()
  .openapi({ ref: "StravaSummaryActivity" });

export const SyncResultSchema = z
  .object({
    id: z.number(),
    status: z.enum(["success", "failed"]),
    error: z.unknown().optional(),
  })
  .openapi({ ref: "SyncResult" });

export const SyncStartedSchema = z
  .object({ status: z.literal("started") })
  .openapi({ ref: "SyncStarted" });

export const StravaSyncResultSchema = z
  .object({
    processed: z.number(),
    created: z.number(),
    linked: z.number(),
    updated: z.number(),
    descriptionsUpdated: z.number(),
    descriptionsRemaining: z.number(),
    failed: z.number(),
  })
  .openapi({ ref: "StravaSyncResult" });

// ─── Proposed-pace response (POST /api/agents/proposed-pace) ──────────────────

export const ProposedPaceResponseSchema = z
  .array(ExpandedIntervalSetSchema)
  .openapi({ ref: "ProposedPaceResponse" });

export const WorkoutInputStepSchema = z
  .object({
    reps: z.number(),
    work_type: z.enum(["DISTANCE", "TIME"]),
    work_value: z.number(),
    recovery_type: z.enum(["DISTANCE", "TIME"]).nullable().optional(),
    recovery_value: z.number().nullable().optional(),
  })
  .openapi({ ref: "WorkoutInputStep" });

export const WorkoutInputSetSchema = z
  .object({
    set_reps: z.number(),
    steps: z.array(WorkoutInputStepSchema),
    set_recovery: z.number().nullable().optional(),
  })
  .openapi({ ref: "WorkoutInputSet" });

export const SuggestSessionRequestSchema = z
  .object({
    structureId: z
      .number()
      .int()
      .optional()
      .describe("Id of a saved interval structure to base the session on."),
    structure: z
      .array(WorkoutInputSetSchema)
      .optional()
      .describe("An explicit workout structure (sets/steps in METERS + SECONDS) instead of a structureId."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe("Target day (YYYY-MM-DD). Defaults to today (athlete's server date)."),
    weather: WeatherSchema.optional().describe(
      "Optional device weather snapshot; when present, target paces are also heat-adjusted by session type.",
    ),
  })
  .refine((b) => b.structureId != null || (b.structure != null && b.structure.length > 0), {
    message: "Provide either structureId or a non-empty structure.",
  })
  .openapi({ ref: "SuggestSessionRequest" });

export const ReadinessSignalsSchema = z
  .object({
    tsb: z.number().nullable(),
    ctl: z.number().nullable(),
    atl: z.number().nullable(),
    ramp: z.number().nullable().optional(),
    hrvStatus: z.enum(["balanced", "unbalanced", "low"]).nullable().optional(),
    sleepScore: z.number().nullable().optional(),
  })
  .openapi({ ref: "ReadinessSignals" });

export const SuggestSessionResponseSchema = z
  .object({
    proposedTraining: ProposedTrainingArtifactSchema,
    paces: z.array(ExpandedIntervalSetSchema),
    readiness: ReadinessSignalsSchema,
    advisory: z.string(),
  })
  .openapi({ ref: "SuggestSessionResponse" });

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

// ─── Progress SSE channel (GET /api/progress/stream) ──────────────────────────
// Cross-repo contract: field names MUST stay in lock-step with the `ProgressEvent`
// discriminated union in src/services/progress_service.ts (the Flutter app mirrors
// these). Each event is serialised as an SSE frame whose `event:` is the `type`
// and whose `data:` is the JSON-encoded payload below.

export const ActivityProgressSchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    startDateLocal: z.string(),
    analysisStatus: z.enum(analysisStatusEnum.enumValues),
    kind: z.literal("analysis"),
  })
  .openapi({ ref: "ActivityProgress" });

export const ProgressSnapshotEventSchema = z
  .object({
    activities: z.array(ActivityProgressSchema),
  })
  .openapi({ ref: "ProgressSnapshotEvent" });

export const ProgressEventSchema = z
  .object({
    id: z.number().int(),
    kind: z.enum(["strava_ingest", "intervals_sync", "analysis"]),
    phase: z.enum(["received", "processing", "ready_for_review"]),
    analysisStatus: z.enum(analysisStatusEnum.enumValues).optional(),
    title: z.string().optional(),
    startDateLocal: z.string().optional(),
    message: z.string().optional(),
  })
  .openapi({ ref: "ProgressEvent" });

export const ProgressDoneEventSchema = z
  .object({
    id: z.number().int(),
    analysisStatus: z.enum(["completed", "initial", "error"]),
    title: z.string().optional(),
  })
  .openapi({ ref: "ProgressDoneEvent" });

export const SyncProgressEventSchema = z
  .object({
    kind: z.string(),
    phase: z.enum(["started", "progress", "completed"]),
    title: z.string(),
    messageKey: z.string().optional(),
    messageArgs: z.record(z.string(), z.string()).optional(),
    retryAt: z.number().int().optional(),
  })
  .openapi({ ref: "SyncProgressEvent" });

export const ProgressErrorEventSchema = z
  .object({
    id: z.number().int().optional(),
    message: z.string(),
  })
  .openapi({ ref: "ProgressErrorEvent" });
