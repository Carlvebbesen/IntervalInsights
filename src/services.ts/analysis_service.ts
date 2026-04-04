import { eq, and, desc } from "drizzle-orm";
import { workoutSet } from "../agent/initial_analysis_agent";
import {
  activities,
  generateIntervalSignature,
  intervalSegments,
  intervalStructures,
  mapSetsToIntervalComponent,
} from "../schema";
import { IGlobalBindings } from "../types/IRouters";
import { generateCompleteIntervalSet } from "./utils";
import z from "zod";
import { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import { buildAnalysisGraph } from "../agent/analysis_graph";
import { Command } from "@langchain/langgraph";
import { TrainingType } from "../schema/enums";

// ── LangGraph pipeline ────────────────────────────────────────────────────────

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
  try {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      new Command({ resume: { notes, sets, trainingType } }),
      {
        configurable: {
          thread_id: String(activityId),
          db,
          stravaAccessToken,
        },
      },
    );
  } catch (error) {
    console.error(`Error in resumeAnalysis for activity ${activityId}:`, error);
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

// ── Proposed-pace helper (unchanged) ─────────────────────────────────────────

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
      actualPace: intervalSegments.actualPace,
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
    actualPace: number;
    targetPace: number | null;
    segmentIndex: number;
    date: Date;
  }[],
  sets: ExpandedIntervalSet[],
): ExpandedIntervalSet[] {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = new Date().getTime();
  const getEffectivePace = (row: (typeof rows)[0]) => row.targetPace ?? row.actualPace;
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

      let relevantRow = sortedRows[currentIntervalNumber];
      if (
        relevantRow &&
        relevantRow.targetType === targetType &&
        Math.abs(relevantRow.targetValue - targetVal) < 1
      ) {
        // falls through to pace logic below
      } else {
        const matchingRows = sortedRows.filter(
          (row) => row.targetType === targetType && Math.abs(row.targetValue - targetVal) < 1,
        );
        if (matchingRows.length > 0) {
          const avgPaceForMatching =
            matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) /
            matchingRows.length;
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
            matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) /
            matchingRows.length;
        } else {
          proposedPace = averagePace ?? getEffectivePace(relevantRow);
        }
      }

      return { ...step, target_pace: proposedPace };
    }),
  }));
}
