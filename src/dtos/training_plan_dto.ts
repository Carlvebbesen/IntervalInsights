import type { z } from "zod";
import type {
  PlannedSessionDao,
  TrainingPlanDao,
  TrainingPlanDetail,
  TrainingPlanWeekDao,
} from "../repositories/training_plan_repository";
import type {
  DeleteTrainingPlanResponseSchema,
  PlannedSessionSchema,
  TrainingPlanDetailSchema,
  TrainingPlanSchema,
  TrainingPlanWeekSchema,
  TrainingPlanWeekWithSessionsSchema,
} from "../schemas/api_schemas";

export type TrainingPlanDto = z.infer<typeof TrainingPlanSchema>;
export type PlannedSessionDto = z.infer<typeof PlannedSessionSchema>;
export type TrainingPlanWeekDto = z.infer<typeof TrainingPlanWeekSchema>;
export type TrainingPlanWeekWithSessionsDto = z.infer<typeof TrainingPlanWeekWithSessionsSchema>;
export type TrainingPlanDetailDto = z.infer<typeof TrainingPlanDetailSchema>;
export type DeleteTrainingPlanDto = z.infer<typeof DeleteTrainingPlanResponseSchema>;

export function toTrainingPlanWeekDto(dao: TrainingPlanWeekDao): TrainingPlanWeekDto {
  return {
    id: dao.id,
    planId: dao.planId,
    weekIndex: dao.weekIndex,
    startDate: dao.startDate,
    phase: dao.phase,
    targetDistanceMeters: dao.targetDistanceMeters,
    targetLoad: dao.targetLoad,
    notes: dao.notes,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}

export function toTrainingPlanDto(dao: TrainingPlanDao): TrainingPlanDto {
  return {
    id: dao.id,
    name: dao.name,
    status: dao.status,
    startDate: dao.startDate,
    endDate: dao.endDate,
    raceEventId: dao.raceEventId,
    goalText: dao.goalText,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}

export function toPlannedSessionDto(dao: PlannedSessionDao): PlannedSessionDto {
  return {
    id: dao.id,
    planId: dao.planId,
    weekId: dao.weekId,
    date: dao.date,
    sessionType: dao.sessionType,
    title: dao.title,
    description: dao.description,
    structure: dao.structure ?? null,
    status: dao.status,
    completedActivityId: dao.completedActivityId,
    sortOrder: dao.sortOrder,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}

function toTrainingPlanWeekWithSessionsDto(
  dao: TrainingPlanWeekDao,
  sessions: PlannedSessionDao[],
): TrainingPlanWeekWithSessionsDto {
  return {
    id: dao.id,
    planId: dao.planId,
    weekIndex: dao.weekIndex,
    startDate: dao.startDate,
    phase: dao.phase,
    targetDistanceMeters: dao.targetDistanceMeters,
    targetLoad: dao.targetLoad,
    notes: dao.notes,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
    sessions: sessions.map(toPlannedSessionDto),
  };
}

export function toTrainingPlanDetailDto(detail: TrainingPlanDetail): TrainingPlanDetailDto {
  const sessionsByWeekId = new Map<number, PlannedSessionDao[]>();
  for (const session of detail.sessions) {
    const bucket = sessionsByWeekId.get(session.weekId);
    if (bucket) bucket.push(session);
    else sessionsByWeekId.set(session.weekId, [session]);
  }

  return {
    ...toTrainingPlanDto(detail.plan),
    weeks: detail.weeks.map((week) =>
      toTrainingPlanWeekWithSessionsDto(week, sessionsByWeekId.get(week.id) ?? []),
    ),
  };
}
