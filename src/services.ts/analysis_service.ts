import { Command } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
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
  const tag = `[startAnalysis activity=${activityId}]`;
  const current = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: { analysisStatus: true },
  });
  if (current?.analysisStatus && SKIP_START_STATUSES.has(current.analysisStatus)) {
    console.log(`${tag} skipping — already in status=${current.analysisStatus}`);
    return;
  }

  const userCtx = await getUserContext(db, userId);
  if (!userCtx) {
    console.error(`${tag} user ${userId} not found — aborting`);
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
  } catch (error) {
    console.error(`Error in startAnalysis for activity ${activityId}:`, error);
    try {
      await db
        .update(activities)
        .set({ analysisStatus: "error" })
        .where(eq(activities.id, activityId));
    } catch (dbError) {
      console.error("Could not set error status in DB:", dbError);
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
  const tag = `[resumeAnalysis activity=${activityId}]`;
  console.log(
    `${tag} starting resume notes.len=${notes.length} sets=${sets.length} trainingType=${trainingType ?? "null"} feeling=${feeling ?? "null"}`,
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

  const userCtx = await getUserContext(db, current.userId);
  if (!userCtx) {
    throw new Error(`User for activity ${activityId} not found`);
  }

  console.log(`${tag} graph-path: invoking Command resume`);
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
    console.log(
      `${tag} pre-invoke graph state: next=[${before.next.join(",")}] taskInterrupts=${beforeInterrupts}`,
    );
    if (!hasPendingWork && beforeInterrupts === 0) {
      throw new Error(
        `Cannot resume activity ${activityId} — thread has no pending interrupt (next=[], no tasks). The checkpoint may be missing or the thread already finished.`,
      );
    }

    await graph.invoke(
      new Command({ resume: { notes, sets, trainingType: finalTrainingType, feeling } }),
      graphConfig,
    );
    console.log(`${tag} graph.invoke returned without throwing`);

    const after = await graph.getState(graphConfig);
    const afterInterrupts = after.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
    if (afterInterrupts > 0) {
      throw new Error(
        `Graph resume did not progress activity ${activityId} — still paused at interrupt (next=[${after.next.join(",")}])`,
      );
    }
  } catch (error) {
    const err = error as { message?: string; stack?: string; name?: string };
    console.error(`${tag} FAILED name=${err?.name} message=${err?.message}`);
    if (err?.stack) console.error(err.stack);
    try {
      await db
        .update(activities)
        .set({ analysisStatus: "error" })
        .where(eq(activities.id, activityId));
    } catch (dbError) {
      console.error("Could not set error status in DB:", dbError);
    }
    throw error;
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
    console.error(`Activity with stravaId ${stravaActivityId} not found in DB`);
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
    console.error(`Activity with stravaId ${stravaActivityId} not found in DB`);
    return;
  }

  if (result.analysisStatus && SKIP_RESTART_STATUSES.has(result.analysisStatus)) {
    console.log(
      `Skipping restart for activity ${result.id} — analysis in progress (status=${result.analysisStatus})`,
    );
    return;
  }

  await resetAnalysisThread(result.id);
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
};
