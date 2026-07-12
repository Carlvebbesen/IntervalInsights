import "zod-openapi/extend";
import { z } from "zod";
import { workoutSet } from "../agent/initial_analysis_agent";
import {
  analysisStatusEnum,
  eventTypeEnum,
  targetTypeEnum,
  trainingTypeEnum,
  workoutPartEnum,
} from "../schema/enums";
import { ExpandedIntervalSetSchema } from "./agent_schemas";
import { ActivityEventSchema } from "./event_schemas";
import { GearSummarySchema } from "./gear_schemas";

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

export const EditorStreamsSchema = z.object({
  time: z.array(z.number()),
  heartrate: z.array(z.number()).nullable(),
  velocity: z.array(z.number()),
});

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

export const SegmentsResponseSchema = z
  .object({
    intervalSegments: z.array(IntervalSegmentSchema),
  })
  .openapi({ ref: "SegmentsResponse" });

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
    kind: z.enum(["strava_ingest", "intervals_ingest", "intervals_sync", "analysis"]),
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
