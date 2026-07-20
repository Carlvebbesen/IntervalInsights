import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { z } from "zod";
import { INTENSITY_AGGRESSIVENESS, VOLUME_AGGRESSIVENESS } from "../plan_builder_state";

// Mirrors the athlete-controllable subset of PlanBuilderInput and the generate
// endpoint's zod bounds — the draft must stay directly submittable to
// POST /training-plans/generate.
export const IntakeDraftSchema = z.object({
  name: z.string().min(1).max(120).optional().describe("plan name"),
  goalText: z.string().max(2000).optional().describe("the athlete's goal in their own words"),
  constraintsText: z
    .string()
    .max(2000)
    .optional()
    .describe("fixed scheduling/logistics constraints, e.g. 'club long run Saturdays'"),
  daysPerWeek: z.number().int().min(3).max(7).optional().describe("run days per week"),
  preferredLongRunDay: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe("preferred long-run day, 0=Monday … 6=Sunday"),
  volumeAggressiveness: z.enum(VOLUME_AGGRESSIVENESS).optional(),
  intensityAggressiveness: z.enum(INTENSITY_AGGRESSIVENESS).optional(),
  maxWeeklyVolumeMeters: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("weekly volume ceiling in meters"),
  crossTrainingPerWeek: z.number().int().min(0).max(2).optional(),
  startDate: z.string().date().optional().describe("plan start, YYYY-MM-DD"),
  endDate: z.string().date().optional().describe("plan end, YYYY-MM-DD"),
});

export type IntakeDraft = z.infer<typeof IntakeDraftSchema>;

const overwrite = <T>(_a: T, b: T): T => b;

export const IntakeStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  userId: Annotation<string>({ reducer: overwrite, default: () => "" }),
  draft: Annotation<IntakeDraft>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  ready: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  athleteBrief: Annotation<string | null>({ reducer: overwrite, default: () => null }),
});

export type IntakeState = typeof IntakeStateAnnotation.State;
