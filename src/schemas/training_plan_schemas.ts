import "zod-openapi/extend";
import { z } from "zod";
import {
  plannedSessionStatusEnum,
  planWeekPhaseEnum,
  trainingPlanStatusEnum,
  trainingTypeEnum,
} from "../schema/enums";
import { WorkoutStructureSetSchema } from "./agent_schemas";

export const PlannedSessionSchema = z
  .object({
    id: z.number(),
    planId: z.number(),
    weekId: z.number(),
    date: z.string(),
    sessionType: z.enum(trainingTypeEnum.enumValues),
    title: z.string(),
    description: z.string().nullable(),
    structure: z.array(WorkoutStructureSetSchema).nullable(),
    status: z.enum(plannedSessionStatusEnum.enumValues),
    completedActivityId: z.number().nullable(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "PlannedSession" });

export const TrainingPlanWeekSchema = z
  .object({
    id: z.number(),
    planId: z.number(),
    weekIndex: z.number(),
    startDate: z.string(),
    phase: z.enum(planWeekPhaseEnum.enumValues).nullable(),
    targetDistanceMeters: z.number().nullable(),
    targetLoad: z.number().nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "TrainingPlanWeek" });

export const TrainingPlanWeekWithSessionsSchema = TrainingPlanWeekSchema.extend({
  sessions: z.array(PlannedSessionSchema),
}).openapi({ ref: "TrainingPlanWeekWithSessions" });

export const TrainingPlanSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.enum(trainingPlanStatusEnum.enumValues),
    startDate: z.string(),
    endDate: z.string(),
    raceEventId: z.number().nullable(),
    goalText: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "TrainingPlan" });

export const TrainingPlanDetailSchema = TrainingPlanSchema.extend({
  weeks: z.array(TrainingPlanWeekWithSessionsSchema),
}).openapi({ ref: "TrainingPlanDetail" });

export const TrainingPlanListResponseSchema = z
  .object({
    data: z.array(TrainingPlanSchema),
  })
  .openapi({ ref: "TrainingPlanListResponse" });

export const DeleteTrainingPlanResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .openapi({ ref: "DeleteTrainingPlanResponse" });
