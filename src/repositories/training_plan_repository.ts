import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../error";
import {
  activities,
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
import type { PlanRevisionChange } from "../schemas/agent_schemas";
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
  constraintsText: trainingPlans.constraintsText,
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

/**
 * The plan's `meta` blob, which `trainingPlanColumns` deliberately omits so it
 * never leaks into a DTO. Only the guard-context loader needs it.
 */
export async function findMetaForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select({ meta: trainingPlans.meta })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)));
  return row?.meta;
}

export async function findByIdForUser(
  db: Db,
  userId: string,
  id: number,
): Promise<TrainingPlanDao | undefined> {
  const [plan] = await db
    .select(trainingPlanColumns)
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)));
  return plan;
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

export interface WeekActualAggregate {
  weekId: number;
  actualDistanceMeters: number;
  actualTrainingLoad: number;
}

/**
 * One grouped pass over a plan's completed sessions and their linked activities:
 * summed actual distance + training load per week (no N+1). Weeks with no linked
 * activity simply don't appear in the result.
 */
export async function actualAggregatesByWeek(
  db: Db,
  planId: number,
): Promise<WeekActualAggregate[]> {
  const rows = await db
    .select({
      weekId: plannedSessions.weekId,
      actualDistanceMeters: sql<number>`coalesce(sum(${activities.distance}), 0)`,
      actualTrainingLoad: sql<number>`coalesce(sum(${activities.trainingLoad}), 0)`,
    })
    .from(plannedSessions)
    .innerJoin(activities, eq(activities.id, plannedSessions.completedActivityId))
    .where(eq(plannedSessions.planId, planId))
    .groupBy(plannedSessions.weekId);

  return rows.map((r) => ({
    weekId: r.weekId,
    actualDistanceMeters: Math.round(Number(r.actualDistanceMeters)),
    actualTrainingLoad: Math.round(Number(r.actualTrainingLoad)),
  }));
}

export interface DuePlannedSession {
  session: PlannedSessionDao;
  planId: number;
}

/**
 * The planned session due today/tomorrow in one of the user's ACTIVE plans, used
 * to make suggest-session plan-aware (D8): only `planned`-status sessions count;
 * today is preferred over tomorrow, ties broken by earliest sortOrder.
 */
export async function findDuePlannedSession(
  db: Db,
  userId: string,
  today: string,
  tomorrow: string,
): Promise<DuePlannedSession | null> {
  const rows = await db
    .select({ session: plannedSessions, planId: plannedSessions.planId })
    .from(plannedSessions)
    .innerJoin(trainingPlans, eq(trainingPlans.id, plannedSessions.planId))
    .where(
      and(
        eq(trainingPlans.userId, userId),
        eq(trainingPlans.status, "active"),
        eq(plannedSessions.status, "planned"),
        inArray(plannedSessions.date, [today, tomorrow]),
      ),
    )
    .orderBy(asc(plannedSessions.date), asc(plannedSessions.sortOrder))
    .limit(1);
  const row = rows[0];
  return row ? { session: row.session, planId: row.planId } : null;
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
  constraintsText?: string | null;
  status?: TrainingPlanStatus;
  meta?: Record<string, unknown>;
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
        constraintsText: input.constraintsText ?? null,
        status: input.status ?? "draft",
        meta: input.meta ?? {},
      })
      .returning(trainingPlanColumns);

    const weeks: TrainingPlanWeekDao[] = [];
    const sessions: PlannedSessionDao[] = [];

    for (const w of input.weeks ?? []) {
      let week: TrainingPlanWeekDao;
      try {
        [week] = await tx
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
      } catch (err) {
        if (isUniqueViolation(err, "training_plan_weeks_plan_week_idx")) {
          throw new AppError(409, "A week with this index already exists in the plan");
        }
        throw err;
      }
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

async function requireSessionInPlan(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: plannedSessions.id })
    .from(plannedSessions)
    .innerJoin(trainingPlans, eq(trainingPlans.id, plannedSessions.planId))
    .where(
      and(
        eq(plannedSessions.id, sessionId),
        eq(plannedSessions.planId, planId),
        eq(trainingPlans.userId, userId),
      ),
    );
  if (!row) throw new AppError(404, "Planned session not found or unauthorized");
}

export async function linkSessionToActivity(
  db: Db,
  userId: string,
  planId: number,
  sessionId: number,
  activityId: number,
): Promise<PlannedSessionDao> {
  await requireSessionInPlan(db, userId, planId, sessionId);

  const activity = await activityRepo.findByIdForUser(db, userId, activityId);
  if (!activity) throw new AppError(404, "Activity not found or unauthorized");

  try {
    const [updated] = await db
      .update(plannedSessions)
      .set({ completedActivityId: activityId, status: "completed" })
      .where(and(eq(plannedSessions.id, sessionId), eq(plannedSessions.planId, planId)))
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
  planId: number,
  sessionId: number,
): Promise<PlannedSessionDao> {
  await requireSessionInPlan(db, userId, planId, sessionId);

  const [updated] = await db
    .update(plannedSessions)
    .set({ completedActivityId: null, status: "planned" })
    .where(and(eq(plannedSessions.id, sessionId), eq(plannedSessions.planId, planId)))
    .returning();
  return updated;
}

interface PlanRevisionHistoryEntry {
  at: string;
  rationale: string | null;
  changes: PlanRevisionChange[];
}

/**
 * Apply a coach-proposed set of plan revisions (D7): validates plan ownership
 * and that every referenced session/week belongs to THIS plan, applies every
 * change, then appends to `meta.revisions` — all inside one transaction, so an
 * invalid reference rolls back the whole batch rather than partially applying.
 */
export async function applyRevisionForUser(
  db: Db,
  userId: string,
  planId: number,
  changes: PlanRevisionChange[],
  rationale?: string | null,
): Promise<TrainingPlanDetail> {
  return db.transaction(async (tx) => {
    const [planRow] = await tx
      .select({ meta: trainingPlans.meta })
      .from(trainingPlans)
      .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
    if (!planRow) throw new AppError(404, "Training plan not found or unauthorized");

    const weekRows = await tx
      .select({ id: trainingPlanWeeks.id })
      .from(trainingPlanWeeks)
      .where(eq(trainingPlanWeeks.planId, planId));
    const weekIds = new Set(weekRows.map((w) => w.id));

    const sessionRows = await tx
      .select({ id: plannedSessions.id })
      .from(plannedSessions)
      .where(eq(plannedSessions.planId, planId));
    const sessionIds = new Set(sessionRows.map((s) => s.id));

    for (const change of changes) {
      if (
        (change.kind === "move_session" ||
          change.kind === "update_session" ||
          change.kind === "drop_session") &&
        !sessionIds.has(change.sessionId)
      ) {
        throw new AppError(400, `Session ${change.sessionId} does not belong to plan ${planId}`);
      }
      if (
        (change.kind === "add_session" || change.kind === "update_week") &&
        !weekIds.has(change.weekId)
      ) {
        throw new AppError(400, `Week ${change.weekId} does not belong to plan ${planId}`);
      }
    }

    for (const change of changes) {
      switch (change.kind) {
        case "move_session":
          await tx
            .update(plannedSessions)
            .set({ date: change.toDate, updatedAt: new Date() })
            .where(eq(plannedSessions.id, change.sessionId));
          break;
        case "update_session": {
          const updates: Partial<InsertPlannedSession> = { updatedAt: new Date() };
          if (change.patch.title !== undefined) updates.title = change.patch.title;
          if (change.patch.sessionType !== undefined)
            updates.sessionType = change.patch.sessionType;
          if (change.patch.description !== undefined)
            updates.description = change.patch.description;
          if (change.patch.structure !== undefined) updates.structure = change.patch.structure;
          await tx
            .update(plannedSessions)
            .set(updates)
            .where(eq(plannedSessions.id, change.sessionId));
          break;
        }
        case "drop_session":
          await tx.delete(plannedSessions).where(eq(plannedSessions.id, change.sessionId));
          break;
        case "add_session":
          await tx.insert(plannedSessions).values({
            planId,
            weekId: change.weekId,
            date: change.session.date,
            sessionType: change.session.sessionType,
            title: change.session.title,
            description: change.session.description ?? null,
            structure: change.session.structure ?? null,
            sortOrder: 0,
          });
          break;
        case "update_week": {
          const updates: Partial<InsertTrainingPlanWeek> = { updatedAt: new Date() };
          if (change.patch.targetDistanceMeters !== undefined) {
            updates.targetDistanceMeters = change.patch.targetDistanceMeters;
          }
          if (change.patch.targetLoad !== undefined) updates.targetLoad = change.patch.targetLoad;
          if (change.patch.notes !== undefined) updates.notes = change.patch.notes;
          if (change.patch.phase !== undefined) updates.phase = change.patch.phase;
          await tx
            .update(trainingPlanWeeks)
            .set(updates)
            .where(eq(trainingPlanWeeks.id, change.weekId));
          break;
        }
      }
    }

    const priorRevisions = Array.isArray(
      (planRow.meta as { revisions?: unknown } | null)?.revisions,
    )
      ? ((planRow.meta as { revisions: PlanRevisionHistoryEntry[] }).revisions ?? [])
      : [];
    const entry: PlanRevisionHistoryEntry = {
      at: new Date().toISOString(),
      rationale: rationale ?? null,
      changes,
    };
    await tx
      .update(trainingPlans)
      .set({
        meta: { ...planRow.meta, revisions: [...priorRevisions, entry] },
        updatedAt: new Date(),
      })
      .where(eq(trainingPlans.id, planId));

    const [plan] = await tx
      .select(trainingPlanColumns)
      .from(trainingPlans)
      .where(eq(trainingPlans.id, planId));
    const weeks = await tx
      .select()
      .from(trainingPlanWeeks)
      .where(eq(trainingPlanWeeks.planId, planId))
      .orderBy(asc(trainingPlanWeeks.weekIndex));
    const sessions = await tx
      .select()
      .from(plannedSessions)
      .where(eq(plannedSessions.planId, planId))
      .orderBy(asc(plannedSessions.date), asc(plannedSessions.sortOrder));

    return { plan, weeks, sessions };
  });
}

export async function deleteAllForUser(db: Db, userId: string): Promise<void> {
  await db.delete(trainingPlans).where(eq(trainingPlans.userId, userId));
}
