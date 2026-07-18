import { and, asc, desc, eq } from "drizzle-orm";
import { AppError } from "../error";
import {
  type InsertPlannedSession,
  type InsertTrainingPlan,
  type InsertTrainingPlanWeek,
  plannedSessions,
  type SelectPlannedSession,
  type SelectTrainingPlan,
  type SelectTrainingPlanWeek,
  type TrainingPlanStatus,
  trainingPlans,
  trainingPlanWeeks,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import * as activityRepo from "./activity_repository";

type Db = IGlobalBindings["db"];

export type TrainingPlanDao = Omit<SelectTrainingPlan, "userId" | "meta">;
export type TrainingPlanWeekDao = SelectTrainingPlanWeek;
export type PlannedSessionDao = SelectPlannedSession;

export const trainingPlanColumns = {
  id: trainingPlans.id,
  name: trainingPlans.name,
  status: trainingPlans.status,
  startDate: trainingPlans.startDate,
  endDate: trainingPlans.endDate,
  raceEventId: trainingPlans.raceEventId,
  goalText: trainingPlans.goalText,
  createdAt: trainingPlans.createdAt,
  updatedAt: trainingPlans.updatedAt,
} as const;

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  // drizzle wraps the driver error in DrizzleQueryError; the pg error with
  // .code/.constraint lives on .cause.
  const candidate =
    typeof err === "object" && err !== null && "cause" in err
      ? ((err as { cause?: unknown }).cause ?? err)
      : err;
  if (typeof candidate !== "object" || candidate === null || !("code" in candidate)) return false;
  const pgErr = candidate as { code?: string; constraint?: string };
  if (pgErr.code !== "23505") return false;
  return constraint === undefined || pgErr.constraint === constraint;
}

async function planOwnedByUser(db: Db, userId: string, planId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: trainingPlans.id })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
  return !!row;
}

function requirePlanOwned(owned: boolean): void {
  if (!owned) throw new AppError(404, "Training plan not found or unauthorized");
}

export async function listForUser(
  db: Db,
  userId: string,
  filters: { status?: TrainingPlanStatus } = {},
): Promise<TrainingPlanDao[]> {
  const where = [eq(trainingPlans.userId, userId)];
  if (filters.status) where.push(eq(trainingPlans.status, filters.status));

  return db
    .select(trainingPlanColumns)
    .from(trainingPlans)
    .where(and(...where))
    .orderBy(desc(trainingPlans.createdAt));
}

export interface TrainingPlanDetail {
  plan: TrainingPlanDao;
  weeks: TrainingPlanWeekDao[];
  sessions: PlannedSessionDao[];
}

export async function getWithDetailForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<TrainingPlanDetail | undefined> {
  const [plan] = await db
    .select(trainingPlanColumns)
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)));
  if (!plan) return undefined;

  const weeks = await db
    .select()
    .from(trainingPlanWeeks)
    .where(eq(trainingPlanWeeks.planId, id))
    .orderBy(asc(trainingPlanWeeks.weekIndex));

  const sessions = await db
    .select()
    .from(plannedSessions)
    .where(eq(plannedSessions.planId, id))
    .orderBy(asc(plannedSessions.date), asc(plannedSessions.sortOrder));

  return { plan, weeks, sessions };
}

export interface CreateSessionInput {
  date: string;
  sessionType: InsertPlannedSession["sessionType"];
  title: string;
  description?: string | null;
  structure?: InsertPlannedSession["structure"];
  sortOrder?: number;
}

export interface CreateWeekInput {
  weekIndex: number;
  startDate: string;
  phase?: InsertTrainingPlanWeek["phase"];
  targetDistanceMeters?: number | null;
  targetLoad?: number | null;
  notes?: string | null;
  sessions?: CreateSessionInput[];
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

export async function createWithChildren(
  db: Db,
  userId: string,
  input: CreateTrainingPlanInput,
): Promise<TrainingPlanDetail> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(trainingPlans)
      .values({
        userId,
        name: input.name,
        startDate: input.startDate,
        endDate: input.endDate,
        raceEventId: input.raceEventId ?? null,
        goalText: input.goalText ?? null,
        status: input.status ?? "draft",
      })
      .returning(trainingPlanColumns);

    const weeks: TrainingPlanWeekDao[] = [];
    const sessions: PlannedSessionDao[] = [];

    for (const w of input.weeks ?? []) {
      const [week] = await tx
        .insert(trainingPlanWeeks)
        .values({
          planId: plan.id,
          weekIndex: w.weekIndex,
          startDate: w.startDate,
          phase: w.phase ?? null,
          targetDistanceMeters: w.targetDistanceMeters ?? null,
          targetLoad: w.targetLoad ?? null,
          notes: w.notes ?? null,
        })
        .returning();
      weeks.push(week);

      for (const s of w.sessions ?? []) {
        const [session] = await tx
          .insert(plannedSessions)
          .values({
            planId: plan.id,
            weekId: week.id,
            date: s.date,
            sessionType: s.sessionType,
            title: s.title,
            description: s.description ?? null,
            structure: s.structure ?? null,
            sortOrder: s.sortOrder ?? 0,
          })
          .returning();
        sessions.push(session);
      }
    }

    return { plan, weeks, sessions };
  });
}

export async function updateForUser(
  db: Db,
  userId: string,
  id: number,
  updates: Partial<InsertTrainingPlan>,
): Promise<TrainingPlanDao | undefined> {
  const [updated] = await db
    .update(trainingPlans)
    .set(updates)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)))
    .returning(trainingPlanColumns);
  return updated;
}

export async function deleteForUser(db: Db, userId: string, id: number): Promise<boolean> {
  const deleted = await db
    .delete(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)))
    .returning({ id: trainingPlans.id });
  return deleted.length > 0;
}

export async function addWeek(
  db: Db,
  userId: string,
  planId: number,
  values: Omit<InsertTrainingPlanWeek, "planId">,
): Promise<TrainingPlanWeekDao> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  try {
    const [week] = await db
      .insert(trainingPlanWeeks)
      .values({ ...values, planId })
      .returning();
    return week;
  } catch (err) {
    if (isUniqueViolation(err, "training_plan_weeks_plan_week_idx")) {
      throw new AppError(409, "A week with this index already exists in the plan");
    }
    throw err;
  }
}

export async function updateWeekForUser(
  db: Db,
  userId: string,
  planId: number,
  weekId: number,
  updates: Partial<InsertTrainingPlanWeek>,
): Promise<TrainingPlanWeekDao | undefined> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  try {
    const [week] = await db
      .update(trainingPlanWeeks)
      .set(updates)
      .where(and(eq(trainingPlanWeeks.id, weekId), eq(trainingPlanWeeks.planId, planId)))
      .returning();
    return week;
  } catch (err) {
    if (isUniqueViolation(err, "training_plan_weeks_plan_week_idx")) {
      throw new AppError(409, "A week with this index already exists in the plan");
    }
    throw err;
  }
}

export async function deleteWeekForUser(
  db: Db,
  userId: string,
  planId: number,
  weekId: number,
): Promise<boolean> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  const deleted = await db
    .delete(trainingPlanWeeks)
    .where(and(eq(trainingPlanWeeks.id, weekId), eq(trainingPlanWeeks.planId, planId)))
    .returning({ id: trainingPlanWeeks.id });
  return deleted.length > 0;
}

async function requireWeekInPlan(db: Db, planId: number, weekId: number): Promise<void> {
  const [week] = await db
    .select({ id: trainingPlanWeeks.id })
    .from(trainingPlanWeeks)
    .where(and(eq(trainingPlanWeeks.id, weekId), eq(trainingPlanWeeks.planId, planId)));
  if (!week) throw new AppError(404, "Week not found in plan");
}

export async function addSession(
  db: Db,
  userId: string,
  planId: number,
  weekId: number,
  values: Omit<InsertPlannedSession, "planId" | "weekId">,
): Promise<PlannedSessionDao> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  await requireWeekInPlan(db, planId, weekId);
  const [session] = await db
    .insert(plannedSessions)
    .values({ ...values, planId, weekId })
    .returning();
  return session;
}

export async function updateSessionForUser(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
  updates: Partial<InsertPlannedSession>,
): Promise<PlannedSessionDao | undefined> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  if (updates.weekId !== undefined) {
    await requireWeekInPlan(db, planId, updates.weekId);
  }
  const [updated] = await db
    .update(plannedSessions)
    .set(updates)
    .where(and(eq(plannedSessions.id, sessionId), eq(plannedSessions.planId, planId)))
    .returning();
  return updated;
}

export async function deleteSessionForUser(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
): Promise<boolean> {
  requirePlanOwned(await planOwnedByUser(db, userId, planId));
  const deleted = await db
    .delete(plannedSessions)
    .where(and(eq(plannedSessions.id, sessionId), eq(plannedSessions.planId, planId)))
    .returning({ id: plannedSessions.id });
  return deleted.length > 0;
}

async function requireSessionOwnedByUser(db: Db, userId: string, sessionId: number): Promise<void> {
  const [row] = await db
    .select({ id: plannedSessions.id })
    .from(plannedSessions)
    .innerJoin(trainingPlans, eq(trainingPlans.id, plannedSessions.planId))
    .where(and(eq(plannedSessions.id, sessionId), eq(trainingPlans.userId, userId)));
  if (!row) throw new AppError(404, "Planned session not found or unauthorized");
}

export async function linkSessionToActivity(
  db: Db,
  userId: string,
  sessionId: number,
  activityId: number,
): Promise<PlannedSessionDao> {
  await requireSessionOwnedByUser(db, userId, sessionId);

  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) throw new AppError(404, "Activity not found or unauthorized");

  try {
    const [updated] = await db
      .update(plannedSessions)
      .set({ completedActivityId: activityId, status: "completed" })
      .where(eq(plannedSessions.id, sessionId))
      .returning();
    return updated;
  } catch (err) {
    if (isUniqueViolation(err, "planned_sessions_completed_activity_idx")) {
      throw new AppError(409, "Activity already linked to another planned session");
    }
    throw err;
  }
}

export async function unlinkSession(
  db: Db,
  userId: string,
  sessionId: number,
): Promise<PlannedSessionDao> {
  await requireSessionOwnedByUser(db, userId, sessionId);

  const [updated] = await db
    .update(plannedSessions)
    .set({ completedActivityId: null, status: "planned" })
    .where(eq(plannedSessions.id, sessionId))
    .returning();
  return updated;
}

export async function deleteAllForUser(db: Db, userId: string): Promise<void> {
  await db.delete(trainingPlans).where(eq(trainingPlans.userId, userId));
}
