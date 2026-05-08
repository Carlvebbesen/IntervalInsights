import { Command } from "@langchain/langgraph";
import { and, desc, eq } from "drizzle-orm";
import type z from "zod";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
import type { workoutSet } from "../agent/initial_analysis_agent";
import {
  activities,
  generateIntervalSignature,
  intervalSegments,
  intervalStructures,
  mapSetsToIntervalComponent,
} from "../schema";
import type { TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { generateCompleteIntervalSet, needCompleteAnalysis } from "./utils";

export const startAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  stravaActivityId: number,
  userId: string,
): Promise<void> => {
  try {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId, stravaActivityId, userId },
      {
        configurable: {
          thread_id: String(activityId),
          db,
          stravaAccessToken,
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
): Promise<void> => {
  const tag = `[resumeAnalysis activity=${activityId}]`;
  console.log(
    `${tag} starting resume notes.len=${notes.length} sets=${sets.length} trainingType=${trainingType ?? "null"}`,
  );

  const current = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: { trainingType: true, draftAnalysisResult: true, analysisStatus: true },
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

  if (!needCompleteAnalysis(finalTrainingType)) {
    console.log(`${tag} fast-path: trainingType=${finalTrainingType} skips LLM segment breakdown`);
    await db
      .update(activities)
      .set({
        analysisStatus: "completed",
        notes,
        trainingType: finalTrainingType,
        draftAnalysisResult: null,
      })
      .where(eq(activities.id, activityId));
    try {
      await resetAnalysisThread(activityId);
    } catch (e) {
      console.warn(`${tag} resetAnalysisThread (post fast-path) failed (non-fatal):`, e);
    }
    return;
  }

  console.log(`${tag} graph-path: invoking Command resume`);
  try {
    const graph = await buildAnalysisGraph();
    const graphConfig = {
      configurable: {
        thread_id: String(activityId),
        db,
        stravaAccessToken,
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
      new Command({ resume: { notes, sets, trainingType: finalTrainingType } }),
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

  const inProgress: Array<typeof result.analysisStatus> = [
    "ongoing_init",
    "ongoing_completed",
    "initial",
  ];
  if (inProgress.includes(result.analysisStatus)) {
    console.log(
      `Skipping restart for activity ${result.id} — analysis in progress (status=${result.analysisStatus})`,
    );
    return;
  }

  await resetAnalysisThread(result.id);
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
};

export const getProposedPaceForStructure = async (
  db: IGlobalBindings["db"],
  userId: string,
  sets: z.infer<typeof workoutSet>[],
): Promise<ExpandedIntervalSet[]> => {
  const components = mapSetsToIntervalComponent(sets);
  const signature = generateIntervalSignature(components);
  const completeIntervalSet = generateCompleteIntervalSet(sets);
  const historyByStructure = await db
    .select({
      targetValue: intervalSegments.targetValue,
      targetType: intervalSegments.targetType,
      actualDistance: intervalSegments.actualDistance,
      actualDuration: intervalSegments.actualDuration,
      targetPace: intervalSegments.targetPace,
      segmentIndex: intervalSegments.segmentIndex,
      date: activities.startDateLocal,
    })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .innerJoin(intervalSegments, eq(intervalSegments.activityId, activities.id))
    .where(
      and(
        eq(activities.userId, userId),
        eq(intervalStructures.signature, signature),
        eq(intervalSegments.type, "INTERVALS"),
      ),
    )
    .orderBy(desc(activities.startDateLocal))
    .limit(10);
  if (historyByStructure.length > 0) {
    return calculateAverages(historyByStructure, completeIntervalSet);
  }
  return completeIntervalSet;
};

function calculateAverages(
  rows: {
    targetValue: number;
    targetType: string;
    actualDistance: number;
    actualDuration: number;
    targetPace: number | null;
    segmentIndex: number;
    date: Date;
  }[],
  sets: ExpandedIntervalSet[],
): ExpandedIntervalSet[] {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const getEffectivePace = (row: (typeof rows)[0]) =>
    row.targetPace ?? (row.actualDuration > 0 ? row.actualDistance / row.actualDuration : 0);
  const sortedRows = [...rows].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const averagePace =
    sortedRows.length > 0
      ? sortedRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / sortedRows.length
      : null;
  let workIntervalCounter = 0;

  return sets.map((set) => ({
    ...set,
    steps: set.steps.map((step) => {
      const currentIntervalNumber = workIntervalCounter++;
      const targetType = step.work_type === "DISTANCE" ? "distance" : "time";
      const targetVal = step.work_value;

      const relevantRow = sortedRows[currentIntervalNumber];
      if (
        relevantRow &&
        relevantRow.targetType === targetType &&
        Math.abs(relevantRow.targetValue - targetVal) < 1
      ) {
      } else {
        const matchingRows = sortedRows.filter(
          (row) => row.targetType === targetType && Math.abs(row.targetValue - targetVal) < 1,
        );
        if (matchingRows.length > 0) {
          const avgPaceForMatching =
            matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / matchingRows.length;
          return { ...step, target_pace: avgPaceForMatching };
        } else {
          return { ...step, target_pace: averagePace };
        }
      }

      if (!relevantRow) {
        return { ...step, target_pace: averagePace };
      }

      const msSinceLastDone = now - relevantRow.date.getTime();
      let proposedPace: number;
      if (msSinceLastDone < ONE_MONTH_MS) {
        proposedPace = getEffectivePace(relevantRow);
      } else {
        const matchingRows = sortedRows.filter(
          (row) =>
            row.targetType === relevantRow.targetType &&
            Math.abs(row.targetValue - relevantRow.targetValue) < 1,
        );
        if (matchingRows.length > 0) {
          proposedPace =
            matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / matchingRows.length;
        } else {
          proposedPace = averagePace ?? getEffectivePace(relevantRow);
        }
      }

      return { ...step, target_pace: proposedPace };
    }),
  }));
}
