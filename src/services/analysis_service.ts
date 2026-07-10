import { Command } from "@langchain/langgraph";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
import type { SegmentBoundary } from "../agent/graph_state";
import { type Logger, logger } from "../logger";
import { activities, users } from "../schema";
import {
  ACTIVE_RUN_STATUSES,
  type AnalysisStatus,
  SKIP_RESTART_STATUSES,
  SKIP_START_STATUSES,
  type TrainingType,
} from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { progressService } from "./progress_service";
import { needCompleteAnalysis, resolveResumeTrainingType } from "./utils";

// Thrown for user-input validation problems in the resume flow. Distinct from
// a server-side error so the router can map it to 400.
export class ResumeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeValidationError";
  }
}

type DoneStatus = "completed" | "initial" | "error";

function toDoneStatus(status: AnalysisStatus | null | undefined, fallback: DoneStatus): DoneStatus {
  if (status === "completed" || status === "initial" || status === "error") return status;
  return fallback;
}

// Flip to `error` only while the run is still in an in-flight status: a late
// failure (e.g. after persistResults wrote `completed`, or a duplicate resume
// on a finished thread) must not clobber a terminal status and trigger the
// requeue's auto-rerun.
async function markErrorIfStatusIn(
  db: IGlobalBindings["db"],
  activityId: number,
  statuses: AnalysisStatus[],
  log: Logger,
): Promise<void> {
  try {
    await db
      .update(activities)
      .set({ analysisStatus: "error" })
      .where(and(eq(activities.id, activityId), inArray(activities.analysisStatus, statuses)));
  } catch (dbErr) {
    log.error({ err: dbErr }, "Could not set error status in DB");
  }
}

async function getUserContext(
  db: IGlobalBindings["db"],
  userId: string,
): Promise<{ intervalsAthleteId: string | null } | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { intervalsAthleteId: true },
  });
  if (!user) return null;
  return { intervalsAthleteId: user.intervalsAthleteId ?? null };
}

export const startAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  stravaActivityId: number | null | undefined,
  userId: string,
  force = false,
): Promise<void> => {
  const log = logger.child({ fn: "startAnalysis", activityId, force });
  // Atomic claim: flip to ongoing_init only if no other starter got there first.
  // A read-then-invoke check leaves a window where two starters (webhook +
  // manual + requeue) both pass, then each resetAnalysisThread deletes the
  // other's checkpoints mid-run. `force` is the user-driven re-analyze path
  // (details view): it may re-run a completed/paused activity, but never one
  // whose graph is actively running.
  const blockedStatuses: AnalysisStatus[] = force
    ? [...ACTIVE_RUN_STATUSES]
    : [...SKIP_START_STATUSES];
  const claimed = await db
    .update(activities)
    .set({ analysisStatus: "ongoing_init", analysisStartedAt: new Date() })
    .where(
      and(
        eq(activities.id, activityId),
        or(
          isNull(activities.analysisStatus),
          notInArray(activities.analysisStatus, blockedStatuses),
        ),
      ),
    )
    .returning({ id: activities.id });
  if (claimed.length === 0) {
    log.info("skipping — another run already claimed or completed this activity");
    return;
  }

  const userCtx = await getUserContext(db, userId);
  if (!userCtx) {
    log.error({ userId }, "user not found — releasing claim");
    await markErrorIfStatusIn(db, activityId, ["ongoing_init"], log);
    return;
  }

  // Always start from a clean checkpoint. Without this, an invoke layered on
  // top of a stale thread (e.g. from a prior dev session or a different state
  // schema) silently corrupts the run and resume crashes later with empty
  // state.streams / state.activityId. resetAnalysisThread is a no-op when no
  // thread exists, so this is safe to call unconditionally here.
  await resetAnalysisThread(activityId);

  await progressService.publish(userId, {
    type: "progress",
    data: { id: activityId, kind: "analysis", phase: "processing", analysisStatus: "ongoing_init" },
  });

  try {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId, stravaActivityId: stravaActivityId ?? null, userId },
      {
        configurable: {
          thread_id: String(activityId),
          db,
          stravaAccessToken,
          intervalsAthleteId: userCtx.intervalsAthleteId,
        },
      },
    );

    const final = await db.query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true },
    });
    await progressService.publish(userId, {
      type: "done",
      data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "initial") },
    });
  } catch (err) {
    log.error({ err }, "Error in startAnalysis");
    await markErrorIfStatusIn(db, activityId, ["pending", "ongoing_init"], log);
    await progressService.publish(userId, {
      type: "done",
      data: { id: activityId, analysisStatus: "error" },
    });
  }
};

export const resumeAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  notes: string,
  sets: ExpandedIntervalSet[],
  trainingType: TrainingType | null,
  feeling: number | null,
  editedSegments: SegmentBoundary[] = [],
): Promise<void> => {
  const log = logger.child({ fn: "resumeAnalysis", activityId });
  log.info(
    {
      notesLen: notes.length,
      sets: sets.length,
      trainingType,
      feeling,
      editedSegments: editedSegments.length,
    },
    "starting resume",
  );

  const current = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: {
      trainingType: true,
      draftAnalysisResult: true,
      analysisStatus: true,
      userId: true,
    },
  });
  if (!current) {
    throw new Error(`Activity ${activityId} not found`);
  }
  const draftType = (current.draftAnalysisResult as { training_type?: TrainingType } | null)
    ?.training_type;
  const finalTrainingType = resolveResumeTrainingType(
    trainingType,
    draftType ?? null,
    current.trainingType ?? null,
  );

  if (!finalTrainingType) {
    throw new Error(`Cannot resume activity ${activityId} — no training type resolved`);
  }

  // Interval-type sessions need a structure for the complete-analysis LLM to
  // anchor on. If the user submitted no sets and the initial agent also
  // produced none, fail fast with a user-facing message instead of either
  // hanging the LLM call or marking the activity as a server error.
  if (needCompleteAnalysis(finalTrainingType)) {
    const draftStructureLen =
      (current.draftAnalysisResult as { structure?: unknown[] } | null)?.structure?.length ?? 0;
    if (sets.length === 0 && draftStructureLen === 0) {
      throw new ResumeValidationError(
        "Define an interval structure before completing — no sets were submitted and the initial analysis did not produce one.",
      );
    }
  }

  const userCtx = await getUserContext(db, current.userId);
  if (!userCtx) {
    throw new Error(`User for activity ${activityId} not found`);
  }

  log.info("graph-path: invoking Command resume");
  const graph = await buildAnalysisGraph();
  const graphConfig = {
    configurable: {
      thread_id: String(activityId),
      db,
      stravaAccessToken,
      intervalsAthleteId: userCtx.intervalsAthleteId,
    },
  };

  // Pre-check OUTSIDE the try: a duplicate/late resume (double-tap, client
  // retry after completion) is a request problem, not a run failure — it must
  // map to 400 and never flip a `completed` activity to `error` (which would
  // trigger the requeue's full auto-rerun).
  const before = await graph.getState(graphConfig);
  const beforeInterrupts = before.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
  const hasPendingWork = before.next.length > 0;
  log.info({ next: before.next, taskInterrupts: beforeInterrupts }, "pre-invoke graph state");
  if (!hasPendingWork && beforeInterrupts === 0) {
    throw new ResumeValidationError(
      `Cannot resume activity ${activityId} — thread has no pending interrupt. The analysis may already be completed or was never started.`,
    );
  }

  await progressService.publish(current.userId, {
    type: "progress",
    data: { id: activityId, kind: "analysis", phase: "processing" },
  });

  try {
    await graph.invoke(
      new Command({
        resume: { notes, sets, trainingType: finalTrainingType, feeling, editedSegments },
      }),
      graphConfig,
    );
    log.info("graph.invoke returned without throwing");
  } catch (err) {
    log.error({ err }, "FAILED");
    await markErrorIfStatusIn(db, activityId, ["initial", "ongoing_completed"], log);
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: "error" },
    });
    throw err;
  }

  const after = await graph.getState(graphConfig);
  const afterInterrupts = after.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
  const final = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: { analysisStatus: true },
  });
  if (afterInterrupts > 0) {
    // Still parked at an interrupt: the resume didn't progress, but nothing
    // failed server-side — leave the status alone so the user can resubmit.
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "initial") },
    });
    throw new Error(
      `Graph resume did not progress activity ${activityId} — still paused at interrupt (next=[${after.next.join(",")}])`,
    );
  }

  await progressService.publish(current.userId, {
    type: "done",
    data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "completed") },
  });
};

export const triggerAnalysisByStravaId = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  stravaActivityId: number,
  userId: string,
): Promise<void> => {
  const result = await db.query.activities.findFirst({
    where: eq(activities.stravaActivityId, stravaActivityId),
    columns: { id: true, analysisStatus: true },
  });
  if (!result) {
    logger.error({ stravaActivityId }, "Activity not found in DB");
    return;
  }

  if (result.analysisStatus && SKIP_RESTART_STATUSES.has(result.analysisStatus)) {
    logger.info(
      { activityId: result.id, status: result.analysisStatus },
      "Skipping restart — analysis in progress",
    );
    return;
  }

  // startAnalysis resets the thread itself, no need to do it twice.
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
};
