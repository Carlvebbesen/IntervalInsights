import {
  type PlannedSessionDto,
  type TrainingPlanDetailDto,
  type TrainingPlanDto,
  type TrainingPlanWeekDto,
  toPlannedSessionDto,
  toTrainingPlanDetailDto,
  toTrainingPlanDto,
  toTrainingPlanWeekDto,
} from "../dtos/training_plan_dto";
import { AppError } from "../error";
import * as raceEventRepo from "../repositories/race_event_repository";
import type { CreateWeekInput } from "../repositories/training_plan_repository";
import * as planRepo from "../repositories/training_plan_repository";
import type {
  InsertPlannedSession,
  InsertTrainingPlan,
  InsertTrainingPlanWeek,
  PlannedSessionStatus,
  PlanWeekPhase,
  TrainingPlanStatus,
  TrainingType,
} from "../schema";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export async function listTrainingPlans(
  db: Db,
  userId: string,
  filters: { status?: TrainingPlanStatus },
): Promise<TrainingPlanDto[]> {
  const rows = await planRepo.listForUser(db, userId, filters);
  return rows.map(toTrainingPlanDto);
}

export async function getTrainingPlan(
  db: Db,
  userId: string,
  id: number,
): Promise<TrainingPlanDetailDto> {
  const detail = await planRepo.getWithDetailForUser(db, userId, id);
  if (!detail) throw new AppError(404, "Training plan not found or unauthorized");
  return toTrainingPlanDetailDto(detail);
}

export interface CreateTrainingPlanInput {
  name: string;
  startDate: string;
  endDate: string;
  raceEventId?: number | null;
  goalText?: string | null;
  status?: TrainingPlanStatus;
  weeks?: CreateWeekInput[];
}

async function assertRaceEventOwned(
  db: Db,
  userId: string,
  raceEventId: number | null | undefined,
): Promise<void> {
  if (raceEventId == null) return;
  const raceEvent = await raceEventRepo.findByIdForUser(db, userId, raceEventId);
  if (!raceEvent) throw new AppError(404, "Race event not found or unauthorized");
}

export async function createTrainingPlan(
  db: Db,
  userId: string,
  input: CreateTrainingPlanInput,
): Promise<TrainingPlanDetailDto> {
  if (input.endDate < input.startDate) {
    throw new AppError(400, "endDate must be on or after startDate");
  }
  await assertRaceEventOwned(db, userId, input.raceEventId);

  const detail = await planRepo.createWithChildren(db, userId, input);
  return toTrainingPlanDetailDto(detail);
}

export interface UpdateTrainingPlanInput {
  name?: string;
  status?: TrainingPlanStatus;
  startDate?: string;
  endDate?: string;
  raceEventId?: number | null;
  goalText?: string | null;
}

export async function updateTrainingPlan(
  db: Db,
  userId: string,
  id: number,
  patch: UpdateTrainingPlanInput,
): Promise<TrainingPlanDto> {
  if (patch.startDate !== undefined || patch.endDate !== undefined) {
    let startDate = patch.startDate;
    let endDate = patch.endDate;
    if (startDate === undefined || endDate === undefined) {
      const current = await planRepo.findByIdForUser(db, userId, id);
      if (!current) throw new AppError(404, "Training plan not found or unauthorized");
      startDate ??= current.startDate;
      endDate ??= current.endDate;
    }
    if (endDate < startDate) {
      throw new AppError(400, "endDate must be on or after startDate");
    }
  }
  if (patch.raceEventId !== undefined) {
    await assertRaceEventOwned(db, userId, patch.raceEventId);
  }

  const updates: Partial<InsertTrainingPlan> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.startDate !== undefined) updates.startDate = patch.startDate;
  if (patch.endDate !== undefined) updates.endDate = patch.endDate;
  if (patch.raceEventId !== undefined) updates.raceEventId = patch.raceEventId;
  if (patch.goalText !== undefined) updates.goalText = patch.goalText;

  const updated = await planRepo.updateForUser(db, userId, id, updates);
  if (!updated) throw new AppError(404, "Training plan not found or unauthorized");
  return toTrainingPlanDto(updated);
}

export async function deleteTrainingPlan(
  db: Db,
  userId: string,
  id: number,
): Promise<{ success: true }> {
  const found = await planRepo.deleteForUser(db, userId, id);
  if (!found) throw new AppError(404, "Training plan not found or unauthorized");
  return { success: true };
}

export interface AddWeekInput {
  weekIndex: number;
  startDate: string;
  phase?: PlanWeekPhase;
  targetDistanceMeters?: number;
  targetLoad?: number;
  notes?: string;
}

export async function addWeek(
  db: Db,
  userId: string,
  planId: number,
  input: AddWeekInput,
): Promise<TrainingPlanWeekDto> {
  const week = await planRepo.addWeek(db, userId, planId, {
    weekIndex: input.weekIndex,
    startDate: input.startDate,
    phase: input.phase ?? null,
    targetDistanceMeters: input.targetDistanceMeters ?? null,
    targetLoad: input.targetLoad ?? null,
    notes: input.notes ?? null,
  });
  return toTrainingPlanWeekDto(week);
}

export interface UpdateWeekInput {
  weekIndex?: number;
  startDate?: string;
  phase?: PlanWeekPhase | null;
  targetDistanceMeters?: number | null;
  targetLoad?: number | null;
  notes?: string | null;
}

export async function updateWeek(
  db: Db,
  userId: string,
  planId: number,
  weekId: number,
  patch: UpdateWeekInput,
): Promise<TrainingPlanWeekDto> {
  const updates: Partial<InsertTrainingPlanWeek> = { updatedAt: new Date() };
  if (patch.weekIndex !== undefined) updates.weekIndex = patch.weekIndex;
  if (patch.startDate !== undefined) updates.startDate = patch.startDate;
  if (patch.phase !== undefined) updates.phase = patch.phase;
  if (patch.targetDistanceMeters !== undefined) {
    updates.targetDistanceMeters = patch.targetDistanceMeters;
  }
  if (patch.targetLoad !== undefined) updates.targetLoad = patch.targetLoad;
  if (patch.notes !== undefined) updates.notes = patch.notes;

  const updated = await planRepo.updateWeekForUser(db, userId, planId, weekId, updates);
  if (!updated) throw new AppError(404, "Week not found in plan");
  return toTrainingPlanWeekDto(updated);
}

export async function deleteWeek(
  db: Db,
  userId: string,
  planId: number,
  weekId: number,
): Promise<{ success: true }> {
  const found = await planRepo.deleteWeekForUser(db, userId, planId, weekId);
  if (!found) throw new AppError(404, "Week not found in plan");
  return { success: true };
}

export interface AddSessionInput {
  weekId: number;
  date: string;
  sessionType: TrainingType;
  title: string;
  description?: string;
  structure?: WorkoutStructureSet[];
  sortOrder?: number;
}

export async function addSession(
  db: Db,
  userId: string,
  planId: number,
  input: AddSessionInput,
): Promise<PlannedSessionDto> {
  const session = await planRepo.addSession(db, userId, planId, input.weekId, {
    date: input.date,
    sessionType: input.sessionType,
    title: input.title,
    description: input.description ?? null,
    structure: input.structure ?? null,
    sortOrder: input.sortOrder ?? 0,
  });
  return toPlannedSessionDto(session);
}

export interface UpdateSessionInput {
  date?: string;
  sessionType?: TrainingType;
  title?: string;
  description?: string | null;
  structure?: WorkoutStructureSet[] | null;
  status?: PlannedSessionStatus;
  sortOrder?: number;
  weekId?: number;
}

export async function updateSession(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
  patch: UpdateSessionInput,
): Promise<PlannedSessionDto> {
  const updates: Partial<InsertPlannedSession> = { updatedAt: new Date() };
  if (patch.date !== undefined) updates.date = patch.date;
  if (patch.sessionType !== undefined) updates.sessionType = patch.sessionType;
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.structure !== undefined) updates.structure = patch.structure;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;
  if (patch.weekId !== undefined) updates.weekId = patch.weekId;

  const updated = await planRepo.updateSessionForUser(db, userId, planId, sessionId, updates);
  if (!updated) throw new AppError(404, "Planned session not found in plan");
  return toPlannedSessionDto(updated);
}

export async function deleteSession(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
): Promise<{ success: true }> {
  const found = await planRepo.deleteSessionForUser(db, userId, planId, sessionId);
  if (!found) throw new AppError(404, "Planned session not found in plan");
  return { success: true };
}

export async function linkSession(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
  activityId: number,
): Promise<PlannedSessionDto> {
  const session = await planRepo.linkSessionToActivity(db, userId, planId, sessionId, activityId);
  return toPlannedSessionDto(session);
}

export async function unlinkSession(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
): Promise<PlannedSessionDto> {
  const session = await planRepo.unlinkSession(db, userId, planId, sessionId);
  return toPlannedSessionDto(session);
}
