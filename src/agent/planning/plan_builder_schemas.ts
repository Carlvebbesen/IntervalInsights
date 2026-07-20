import { z } from "zod";
import { planWeekPhaseEnum, trainingTypeEnum } from "../../schema/enums";
import { WorkoutStructureSetSchema } from "../../schemas/agent_schemas";

export const PlanMacroWeekSchema = z.object({
  weekIndex: z.number().int().describe("1-based, contiguous week number"),
  startDate: z.string().describe("Monday-aligned week start (YYYY-MM-DD)"),
  phase: z.enum(planWeekPhaseEnum.enumValues),
  targetDistanceMeters: z.number().int().describe("Planned running volume for the week, in METERS"),
  notes: z.string().nullable().optional(),
  keySessions: z
    .array(z.string())
    .describe(
      "Short labels for the week's quality sessions, e.g. '5x1000m', 'Tempo 20min', 'Long run'",
    ),
});
export type PlanMacroWeek = z.infer<typeof PlanMacroWeekSchema>;

export const PlanMacroSchema = z.object({
  name: z.string(),
  rationale: z.string(),
  weeks: z.array(PlanMacroWeekSchema),
});
export type PlanMacro = z.infer<typeof PlanMacroSchema>;

export const GeneratedSessionSchema = z.object({
  // Same strictness the user-facing API applies to a caller-supplied date: a
  // bare z.string() let a malformed LLM date through repairSessionDate (NaN
  // fails both bound comparisons) straight into the persisted session.
  date: z.string().date().describe("YYYY-MM-DD; must fall within the target week"),
  sessionType: z.enum(trainingTypeEnum.enumValues),
  title: z.string(),
  description: z.string().nullable().optional(),
  structure: z
    .array(WorkoutStructureSetSchema)
    .nullable()
    .optional()
    .describe(
      "null for EASY/LONG/RECOVERY; sets/steps with reps + work values for interval types. NEVER include target paces.",
    ),
});
export type GeneratedSession = z.infer<typeof GeneratedSessionSchema>;

export const GeneratedWeekSessionsSchema = z.object({
  weekIndex: z.number().int(),
  sessions: z.array(GeneratedSessionSchema),
});
export type GeneratedWeekSessions = z.infer<typeof GeneratedWeekSessionsSchema>;

export const GenerateSessionsOutputSchema = z.object({
  weeks: z.array(GeneratedWeekSessionsSchema),
});
export type GenerateSessionsOutput = z.infer<typeof GenerateSessionsOutputSchema>;

export type PlanReviewAction = "accept" | "adjust";

export const PlanReviewResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("adjust"), feedback: z.string().min(1).max(2000) }),
]);
export type PlanReviewResume = z.infer<typeof PlanReviewResumeSchema>;
