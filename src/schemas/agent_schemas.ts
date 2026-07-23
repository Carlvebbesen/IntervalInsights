import "zod-openapi/extend";
import { z } from "zod";
import {
  analysisStatusEnum,
  planWeekPhaseEnum,
  trainingTypeEnum,
  workoutPartEnum,
} from "../schema/enums";
import { WeatherSchema } from "./common_schemas";

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
    target_paces: z.array(z.number()).nullable().optional(),
  })
  .openapi({ ref: "WorkoutStructureStep" });

export const WorkoutStructureSetSchema = z
  .object({
    set_reps: z.number(),
    set_recovery: z.number().nullable().optional(),
    steps: z.array(WorkoutStructureStepSchema),
  })
  .openapi({ ref: "WorkoutStructureSet" });

export type WorkoutStructureSet = z.infer<typeof WorkoutStructureSetSchema>;

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

export const PlanRevisionMoveSessionSchema = z
  .object({
    kind: z.literal("move_session"),
    sessionId: z.number().int().positive(),
    toDate: z.string().date(),
  })
  .openapi({ ref: "PlanRevisionMoveSession" });

export const PlanRevisionUpdateSessionSchema = z
  .object({
    kind: z.literal("update_session"),
    sessionId: z.number().int().positive(),
    patch: z.object({
      title: z.string().min(1).optional(),
      sessionType: z.enum(trainingTypeEnum.enumValues).optional(),
      description: z.string().nullable().optional(),
      structure: z.array(WorkoutStructureSetSchema).nullable().optional(),
    }),
  })
  .openapi({ ref: "PlanRevisionUpdateSession" });

export const PlanRevisionDropSessionSchema = z
  .object({
    kind: z.literal("drop_session"),
    sessionId: z.number().int().positive(),
  })
  .openapi({ ref: "PlanRevisionDropSession" });

export const PlanRevisionAddSessionSchema = z
  .object({
    kind: z.literal("add_session"),
    weekId: z.number().int().positive(),
    session: z.object({
      date: z.string().date(),
      sessionType: z.enum(trainingTypeEnum.enumValues),
      title: z.string().min(1),
      description: z.string().min(1).optional(),
      structure: z.array(WorkoutStructureSetSchema).nullable().optional(),
    }),
  })
  .openapi({ ref: "PlanRevisionAddSession" });

export const PlanRevisionUpdateWeekSchema = z
  .object({
    kind: z.literal("update_week"),
    weekId: z.number().int().positive(),
    patch: z.object({
      targetDistanceMeters: z.number().int().positive().nullable().optional(),
      targetLoad: z.number().int().positive().nullable().optional(),
      notes: z.string().nullable().optional(),
      phase: z.enum(planWeekPhaseEnum.enumValues).nullable().optional(),
    }),
  })
  .openapi({ ref: "PlanRevisionUpdateWeek" });

export const PlanRevisionChangeSchema = z.discriminatedUnion("kind", [
  PlanRevisionMoveSessionSchema,
  PlanRevisionUpdateSessionSchema,
  PlanRevisionDropSessionSchema,
  PlanRevisionAddSessionSchema,
  PlanRevisionUpdateWeekSchema,
]);
export type PlanRevisionChange = z.infer<typeof PlanRevisionChangeSchema>;

export const PlanRevisionArtifactSchema = z
  .object({
    type: z.literal("plan_revision"),
    id: z.string(),
    planId: z.number().int().positive(),
    title: z.string(),
    rationale: z.string(),
    changes: z.array(PlanRevisionChangeSchema).min(1),
  })
  .openapi({ ref: "PlanRevisionArtifact" });

export type PlanRevisionArtifact = z.infer<typeof PlanRevisionArtifactSchema>;

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
    gearUpdatedFromStrava: z.boolean(),
    intervalStructureId: z.number().nullable(),
    suggestedGearId: z.number().nullable(),
    gearSuggestions: z.array(z.number()),
    // Compact proposed-structure badge (e.g. "10×1000m"); null when the draft has
    // no structure. Lets the list distinguish quick-complete from open-and-review.
    structureSummary: z.string().nullable(),
  })
  .openapi({ ref: "PendingActivity" });

export const ProposedPaceResponseSchema = z
  .array(ExpandedIntervalSetSchema)
  .openapi({ ref: "ProposedPaceResponse" });

export const AutoCompleteAllResponseSchema = z
  .object({
    completed: z.array(z.number()),
    skipped: z.array(
      z.object({
        activityId: z.number(),
        reason: z.enum(["no_structure", "quota_exhausted", "error"]),
      }),
    ),
  })
  .openapi({ ref: "AutoCompleteAllResponse" });

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
      .describe(
        "An explicit workout structure (sets/steps in METERS + SECONDS) instead of a structureId.",
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe("Target day (YYYY-MM-DD). Defaults to today (athlete's server date)."),
    weather: WeatherSchema.optional().describe(
      "Optional device weather snapshot; when present, target paces are also heat-adjusted by session type.",
    ),
    // "recommended" is the pre-rename wire value for "ai" — installed app
    // builds still send it, so the backend must accept it whichever deploys first.
    mode: z
      .preprocess(
        (v) => (v === "recommended" ? "ai" : v),
        z.enum(["plan", "signature", "ai"]).optional(),
      )
      .describe(
        "Absent = auto: a planned session due today/tomorrow in an active plan is used as the default suggestion, otherwise 'signature'. 'plan' forces the due planned session (404 if none). 'signature' keeps the picked structure's shape (only modest readiness tweaks). 'ai' lets the coach recommend the best-fitting session for today, free to reshape it.",
      ),
    recentlySuggested: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe(
        "Titles of sessions already suggested to the athlete in this sitting (client-held state). Passed back on a 'suggest another' tap so the coach proposes something different and the brief response cache is bypassed. AI mode only.",
      ),
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
    mode: z
      .enum(["plan", "signature", "ai"])
      .describe("The resolved suggestion mode this response was built with."),
    plannedSessionId: z
      .number()
      .nullable()
      .optional()
      .describe("In plan mode, the planned session this suggestion was built from."),
    planId: z
      .number()
      .nullable()
      .optional()
      .describe("In plan mode, the training plan the session belongs to."),
  })
  .openapi({ ref: "SuggestSessionResponse" });
