import { Command } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
import type { SegmentBoundary } from "../agent/graph_state";
import { logger } from "../logger";
import { activities, users } from "../schema";
import {
  type AnalysisStatus,
  SKIP_RESTART_STATUSES,
  SKIP_START_STATUSES,
  type TrainingType,
} from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { progressService } from "./progress_service";
import { needCompleteAnalysis } from "./utils";

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

async function getUserContext(
  db: IGlobalBindings["db"],
  userId: string,
): Promise<{ clerkId: string; intervalsAthleteId: string | null } | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { clerkId: true, intervalsAthleteId: true },
  });
  if (!user) return null;
  return { clerkId: user.clerkId, intervalsAthleteId: user.intervalsAthleteId ?? null };
}

export const startAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  stravaActivityId: number | null | undefined,
  userId: string,
): Promise<void> => {
  const log = logger.child({ fn: "startAnalysis", activityId });
  const current = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: { analysisStatus: true },
  });
  if (current?.analysisStatus && SKIP_START_STATUSES.has(current.analysisStatus)) {
    log.info({ status: current.analysisStatus }, "skipping — already in this status");
    return;
  }

  const userCtx = await getUserContext(db, userId);
  if (!userCtx) {
    log.error({ userId }, "user not found — aborting");
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
          clerkUserId: userCtx.clerkId,
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
    try {
      await db
        .update(activities)
        .set({ analysisStatus: "error" })
        .where(eq(activities.id, activityId));
    } catch (dbErr) {
      log.error({ err: dbErr }, "Could not set error status in DB");
    }
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
  const finalTrainingType: TrainingType | null =
    trainingType ?? current.trainingType ?? draftType ?? null;

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
  try {
    const graph = await buildAnalysisGraph();
    const graphConfig = {
      configurable: {
        thread_id: String(activityId),
        db,
        stravaAccessToken,
        clerkUserId: userCtx.clerkId,
        intervalsAthleteId: userCtx.intervalsAthleteId,
      },
    };

    const before = await graph.getState(graphConfig);
    const beforeInterrupts = before.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
    const hasPendingWork = before.next.length > 0;
    log.info({ next: before.next, taskInterrupts: beforeInterrupts }, "pre-invoke graph state");
    if (!hasPendingWork && beforeInterrupts === 0) {
      throw new Error(
        `Cannot resume activity ${activityId} — thread has no pending interrupt (next=[], no tasks). The checkpoint may be missing or the thread already finished.`,
      );
    }

    await progressService.publish(current.userId, {
      type: "progress",
      data: { id: activityId, kind: "analysis", phase: "processing" },
    });

    await graph.invoke(
      new Command({
        resume: { notes, sets, trainingType: finalTrainingType, feeling, editedSegments },
      }),
      graphConfig,
    );
    log.info("graph.invoke returned without throwing");

    const after = await graph.getState(graphConfig);
    const afterInterrupts = after.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
    if (afterInterrupts > 0) {
      throw new Error(
        `Graph resume did not progress activity ${activityId} — still paused at interrupt (next=[${after.next.join(",")}])`,
      );
    }

    const final = await db.query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true },
    });
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "completed") },
    });
  } catch (err) {
    log.error({ err }, "FAILED");
    try {
      await db
        .update(activities)
        .set({ analysisStatus: "error" })
        .where(eq(activities.id, activityId));
    } catch (dbErr) {
      log.error({ err: dbErr }, "Could not set error status in DB");
    }
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: "error" },
    });
    throw err;
  }
};

export const startAnalysisByStravaId = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  stravaActivityId: number,
  userId: string,
): Promise<void> => {
  const result = await db.query.activities.findFirst({
    where: eq(activities.stravaActivityId, stravaActivityId),
    columns: { id: true },
  });
  if (!result) {
    logger.error({ stravaActivityId }, "Activity not found in DB");
    return;
  }
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
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
