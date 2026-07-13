import "zod-openapi/extend";
import { z } from "zod";
import { analysisStatusEnum, trainingTypeEnum, workoutPartEnum } from "../schema/enums";
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
    mode: z
      .enum(["signature", "recommended"])
      .optional()
      .default("signature")
      .describe(
        "'signature' keeps the picked structure's shape (only modest readiness tweaks). 'recommended' lets the coach recommend the best-fitting session for today from the athlete's training context, free to reshape it.",
      ),
    recentlySuggested: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe(
        "Titles of sessions already suggested to the athlete in this sitting (client-held state). Passed back on a 'suggest another' tap so the coach proposes something different and the brief response cache is bypassed. Recommended mode only.",
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
