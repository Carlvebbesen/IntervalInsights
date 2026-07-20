import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { z } from "zod";
import { INTENSITY_AGGRESSIVENESS, VOLUME_AGGRESSIVENESS } from "../plan_builder_state";

// Mirrors the athlete-controllable subset of PlanBuilderInput and the generate
// endpoint's zod bounds — the draft must stay directly submittable to
// POST /training-plans/generate.
// Every field is nullable so the model can CLEAR a setting the athlete
// retracts ("actually, no volume cap") — the draft reducer deletes null keys.
export const IntakeDraftSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional().describe("plan name"),
  goalText: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("the athlete's goal in their own words"),
  constraintsText: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("fixed scheduling/logistics constraints, e.g. 'club long run Saturdays'"),
  daysPerWeek: z.number().int().min(3).max(7).nullable().optional().describe("run days per week"),
  preferredLongRunDay: z
    .number()
    .int()
    .min(0)
    .max(6)
    .nullable()
    .optional()
    .describe("preferred long-run day, 0=Monday … 6=Sunday"),
  volumeAggressiveness: z.enum(VOLUME_AGGRESSIVENESS).nullable().optional(),
  intensityAggressiveness: z.enum(INTENSITY_AGGRESSIVENESS).nullable().optional(),
  maxWeeklyVolumeMeters: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("weekly volume ceiling in meters — null clears a retracted cap"),
  crossTrainingPerWeek: z.number().int().min(0).max(2).nullable().optional(),
  startDate: z.string().date().nullable().optional().describe("plan start, YYYY-MM-DD"),
  endDate: z.string().date().nullable().optional().describe("plan end, YYYY-MM-DD"),
});

export type IntakeDraft = z.infer<typeof IntakeDraftSchema>;

const overwrite = <T>(_a: T, b: T): T => b;

function mergeDraft(a: IntakeDraft, b: IntakeDraft): IntakeDraft {
  const merged: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as IntakeDraft;
}

export const IntakeStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  userId: Annotation<string>({ reducer: overwrite, default: () => "" }),
  draft: Annotation<IntakeDraft>({
    reducer: mergeDraft,
    default: () => ({}),
  }),
  ready: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  athleteBrief: Annotation<string | null>({ reducer: overwrite, default: () => null }),
});

export type IntakeState = typeof IntakeStateAnnotation.State;
