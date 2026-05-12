import { and, desc, eq } from "drizzle-orm";
import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import {
  activities,
  generateIntervalSignature,
  intervalSegments,
  intervalStructures,
  mapSetsToIntervalComponent,
} from "../schema";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { generateCompleteIntervalSet } from "./utils";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

type HistoryRow = {
  targetValue: number;
  targetType: string;
  actualDistance: number;
  actualDuration: number;
  targetPace: number | null;
  segmentIndex: number;
  date: Date;
};

export const getProposedPaceForStructure = async (
  db: IGlobalBindings["db"],
  userId: string,
  sets: z.infer<typeof workoutSet>[],
): Promise<ExpandedIntervalSet[]> => {
  const components = mapSetsToIntervalComponent(sets);
  const signature = generateIntervalSignature(components);
  const completeIntervalSet = generateCompleteIntervalSet(sets);

  const history = await db
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
    .limit(HISTORY_LIMIT);

  if (history.length === 0) return completeIntervalSet;
  return interpolatePaces(history, completeIntervalSet);
};

const getEffectivePace = (row: HistoryRow): number =>
  row.targetPace ?? (row.actualDuration > 0 ? row.actualDistance / row.actualDuration : 0);

function interpolatePaces(rows: HistoryRow[], sets: ExpandedIntervalSet[]): ExpandedIntervalSet[] {
  const now = Date.now();
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

      const isAligned =
        !!relevantRow &&
        relevantRow.targetType === targetType &&
        Math.abs(relevantRow.targetValue - targetVal) < 1;

      if (!isAligned) {
        const matchingRows = sortedRows.filter(
          (row) => row.targetType === targetType && Math.abs(row.targetValue - targetVal) < 1,
        );
        if (matchingRows.length > 0) {
          const avgPaceForMatching =
            matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / matchingRows.length;
          return { ...step, target_pace: avgPaceForMatching };
        }
        return { ...step, target_pace: averagePace };
      }

      const msSinceLastDone = now - relevantRow.date.getTime();
      if (msSinceLastDone < ONE_MONTH_MS) {
        return { ...step, target_pace: getEffectivePace(relevantRow) };
      }

      const matchingRows = sortedRows.filter(
        (row) =>
          row.targetType === relevantRow.targetType &&
          Math.abs(row.targetValue - relevantRow.targetValue) < 1,
      );
      const proposedPace =
        matchingRows.length > 0
          ? matchingRows.reduce((sum, row) => sum + getEffectivePace(row), 0) / matchingRows.length
          : (averagePace ?? getEffectivePace(relevantRow));
      return { ...step, target_pace: proposedPace };
    }),
  }));
}
