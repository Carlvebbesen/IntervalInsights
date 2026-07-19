import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import type { GraphDb } from "../agent/graph_state";
import {
  plannedSessions,
  RUNNING_SPORT_TYPES,
  type TrainingType,
  trainingBucketFor,
  trainingPlans,
} from "../schema";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";
import { toISODate } from "./utils";

const LINK_SCORE_THRESHOLD = 5;

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const candidate =
    typeof err === "object" && err !== null && "cause" in err
      ? ((err as { cause?: unknown }).cause ?? err)
      : err;
  if (typeof candidate !== "object" || candidate === null || !("code" in candidate)) return false;
  const pgErr = candidate as { code?: string; constraint?: string };
  return pgErr.code === "23505" && pgErr.constraint === constraint;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

function dayDiff(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.abs(Math.round(ms / 86_400_000));
}

function structureWorkRepCount(structure: WorkoutStructureSet[] | null | undefined): number | null {
  if (!structure || structure.length === 0) return null;
  return structure.reduce(
    (total, set) => total + set.set_reps * set.steps.reduce((s, step) => s + step.reps, 0),
    0,
  );
}

function dateScore(candidateDate: string, activityDateLocal: string): number {
  return candidateDate === activityDateLocal ? 3 : 1;
}

function typeScore(sessionType: TrainingType, trainingType: TrainingType): number {
  if (sessionType === trainingType) return 4;
  const sessionBucket = trainingBucketFor(sessionType);
  if (sessionBucket !== null && sessionBucket === trainingBucketFor(trainingType)) return 2;
  return 0;
}

function structureScore(
  candidateStructure: WorkoutStructureSet[] | null | undefined,
  structureRepCount: number | null | undefined,
): number {
  const candidateTotal = structureWorkRepCount(candidateStructure);
  if (candidateTotal === null) {
    return structureRepCount == null ? 1 : 0;
  }
  if (structureRepCount == null) return 0;
  if (candidateTotal === structureRepCount) return 2;
  const tolerance = candidateTotal * 0.2;
  return Math.abs(candidateTotal - structureRepCount) <= tolerance ? 1 : 0;
}

export interface MatchActivityInput {
  userId: string;
  activityId: number;
  activityDateLocal: string;
  trainingType: TrainingType | null;
  sportType: string;
  structureRepCount?: number | null;
}

export interface MatchActivityResult {
  linked: boolean;
  sessionId?: number;
}

export async function matchActivityToPlannedSession(
  db: GraphDb,
  input: MatchActivityInput,
): Promise<MatchActivityResult> {
  if (!(RUNNING_SPORT_TYPES as readonly string[]).includes(input.sportType)) {
    return { linked: false };
  }
  if (!input.trainingType) return { linked: false };

  const [alreadyLinked] = await db
    .select({ id: plannedSessions.id })
    .from(plannedSessions)
    .where(eq(plannedSessions.completedActivityId, input.activityId));
  if (alreadyLinked) return { linked: false };

  const minDate = shiftDate(input.activityDateLocal, -1);
  const maxDate = shiftDate(input.activityDateLocal, 1);

  const candidates = await db
    .select({
      id: plannedSessions.id,
      planId: plannedSessions.planId,
      date: plannedSessions.date,
      sessionType: plannedSessions.sessionType,
      structure: plannedSessions.structure,
    })
    .from(plannedSessions)
    .innerJoin(trainingPlans, eq(trainingPlans.id, plannedSessions.planId))
    .where(
      and(
        eq(trainingPlans.userId, input.userId),
        eq(trainingPlans.status, "active"),
        eq(plannedSessions.status, "planned"),
        gte(plannedSessions.date, minDate),
        lte(plannedSessions.date, maxDate),
      ),
    );

  const trainingType = input.trainingType;
  const scored = candidates
    .map((c) => ({
      ...c,
      score:
        dateScore(c.date, input.activityDateLocal) +
        typeScore(c.sessionType, trainingType) +
        structureScore(c.structure, input.structureRepCount),
    }))
    .filter((c) => c.score >= LINK_SCORE_THRESHOLD)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const diffA = dayDiff(a.date, input.activityDateLocal);
      const diffB = dayDiff(b.date, input.activityDateLocal);
      if (diffA !== diffB) return diffA - diffB;
      return a.id - b.id;
    });

  const best = scored[0];
  if (!best) return { linked: false };

  try {
    const updated = await db
      .update(plannedSessions)
      .set({ completedActivityId: input.activityId, status: "completed", updatedAt: new Date() })
      .where(and(eq(plannedSessions.id, best.id), eq(plannedSessions.planId, best.planId)))
      .returning({ id: plannedSessions.id });
    if (updated.length === 0) return { linked: false };
    return { linked: true, sessionId: best.id };
  } catch (err) {
    if (isUniqueViolation(err, "planned_sessions_completed_activity_idx")) return { linked: false };
    throw err;
  }
}

export async function sweepOverduePlannedSessions(
  db: GraphDb,
  userId: string,
  todayLocal: string,
): Promise<number> {
  const cutoff = shiftDate(todayLocal, -1);

  const overdue = await db
    .select({ id: plannedSessions.id })
    .from(plannedSessions)
    .innerJoin(trainingPlans, eq(trainingPlans.id, plannedSessions.planId))
    .where(
      and(
        eq(trainingPlans.userId, userId),
        eq(trainingPlans.status, "active"),
        eq(plannedSessions.status, "planned"),
        lt(plannedSessions.date, cutoff),
      ),
    );
  const ids = overdue.map((row) => row.id);
  if (ids.length === 0) return 0;

  const updated = await db
    .update(plannedSessions)
    .set({ status: "skipped", updatedAt: new Date() })
    .where(inArray(plannedSessions.id, ids))
    .returning({ id: plannedSessions.id });
  return updated.length;
}
