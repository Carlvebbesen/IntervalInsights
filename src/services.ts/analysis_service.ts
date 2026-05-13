import { Command } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
import { logger } from "../logger";
import { activities, users } from "../schema";
import { SKIP_RESTART_STATUSES, SKIP_START_STATUSES, type TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";

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
  stravaActivityId: number,
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

  try {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId, stravaActivityId, userId },
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
): Promise<void> => {
  const log = logger.child({ fn: "resumeAnalysis", activityId });
  log.info({ notesLen: notes.length, sets: sets.length, trainingType, feeling }, "starting resume");

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

    await graph.invoke(
      new Command({ resume: { notes, sets, trainingType: finalTrainingType, feeling } }),
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

export const restartAnalysisByStravaId = async (
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

  await resetAnalysisThread(result.id);
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
};
