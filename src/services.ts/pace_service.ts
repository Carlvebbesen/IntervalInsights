import { and, desc, eq } from "drizzle-orm";
import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import {
  activities,
  generateIntervalSignature,
  intervalStructures,
  mapSetsToIntervalComponent,
} from "../schema";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import type { Lap } from "../types/strava/IDetailedActivity";
import { getSegmentsForActivity, matchLapsToExpandedSteps } from "./lap_derivation_service";
import { generateCompleteIntervalSet } from "./utils";

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;
const MAX_HISTORY_ACTIVITIES = 5;

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
  clerkUserId: string,
  sets: z.infer<typeof workoutSet>[],
): Promise<ExpandedIntervalSet[]> => {
  const tag = "[getProposedPaceForStructure]";
  const components = mapSetsToIntervalComponent(sets);
  const signature = generateIntervalSignature(components);
  const completeIntervalSet = generateCompleteIntervalSet(sets);

  const matchingActivities = await db
    .select({
      activityId: activities.id,
      date: activities.startDateLocal,
    })
    .from(intervalStructures)
    .innerJoin(activities, eq(activities.intervalStructureId, intervalStructures.id))
    .where(and(eq(activities.userId, userId), eq(intervalStructures.signature, signature)))
    .orderBy(desc(activities.startDateLocal))
    .limit(MAX_HISTORY_ACTIVITIES);

  console.log(`${tag} signature=${signature} matchingActivities=${matchingActivities.length}`);

  const history: HistoryRow[] = [];
  for (const a of matchingActivities) {
    if (history.length >= HISTORY_LIMIT) break;
    const segs = await getSegmentsForActivity(db, clerkUserId, a.activityId);
    const before = history.length;
    for (const seg of segs) {
      if (seg.type !== "INTERVALS") continue;
      history.push({
        targetValue: seg.targetValue,
        targetType: seg.targetType,
        actualDistance: seg.actualDistance,
        actualDuration: seg.actualDuration,
        targetPace: seg.targetPace ?? null,
        segmentIndex: seg.segmentIndex,
        date: a.date,
      });
      if (history.length >= HISTORY_LIMIT) break;
    }
    console.log(
      `${tag} activity=${a.activityId} (${a.date.toISOString().split("T")[0]}) contributed ${history.length - before} INTERVALS rows`,
    );
  }

  console.log(`${tag} collected ${history.length} history rows total`);
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

export function getProposedPaceFromLaps(
  laps: Lap[],
  sets: z.infer<typeof workoutSet>[],
): ExpandedIntervalSet[] | null {
  const tag = "[getProposedPaceFromLaps]";
  const expanded = generateCompleteIntervalSet(sets);
  console.log(
    `${tag} laps=${laps.length} expectedWorkSteps=${expanded.reduce((s, x) => s + x.steps.length, 0)} structureSets=${sets.length}`,
  );
  console.log(
    `${tag} laps detail: ${laps
      .map(
        (l, i) =>
          `#${i} dist=${l.distance}m time=${l.moving_time}s speed=${l.average_speed.toFixed(2)}m/s`,
      )
      .join(" | ")}`,
  );

  const matchedLapIdx = matchLapsToExpandedSteps(laps, expanded, tag);
  if (!matchedLapIdx) return null;

  const matchedPaces = matchedLapIdx.map((i) => laps[i].average_speed);
  console.log(
    `${tag} matched ${matchedPaces.length} steps, paces (m/s): [${matchedPaces.map((p) => p.toFixed(2)).join(", ")}]`,
  );

  const sumLapsBetween = (
    fromExclusive: number,
    toExclusive: number,
  ): { distance: number; movingTime: number; count: number } => {
    let distance = 0;
    let movingTime = 0;
    let count = 0;
    for (let i = fromExclusive + 1; i < toExclusive; i++) {
      distance += laps[i].distance;
      movingTime += laps[i].moving_time;
      count++;
    }
    return { distance, movingTime, count };
  };

  let globalStep = 0;
  const result: ExpandedIntervalSet[] = expanded.map((set, setIdx) => {
    const isLastSet = setIdx === expanded.length - 1;
    const lastStepIdxInSet = set.steps.length - 1;
    let derivedSetRecovery: number | null = null;

    const newSteps = set.steps.map((step, stepIdx) => {
      const target_pace = matchedPaces[globalStep];
      const isLastStepInSet = stepIdx === lastStepIdxInSet;
      const currentLapIdx = matchedLapIdx[globalStep];
      const nextLapIdx = matchedLapIdx[globalStep + 1];

      let recovery_value = step.recovery_value;
      let recovery_type = step.recovery_type;

      if (!isLastStepInSet && nextLapIdx !== undefined) {
        const gap = sumLapsBetween(currentLapIdx, nextLapIdx);
        if (gap.count > 0) {
          const useDistance = recovery_type === "DISTANCE";
          recovery_value = useDistance ? Math.round(gap.distance) : Math.round(gap.movingTime);
          if (!recovery_type) recovery_type = "TIME";
          console.log(
            `${tag} step #${globalStep} rest: ${gap.count} lap(s) -> ${recovery_value}${useDistance ? "m" : "s"}`,
          );
        }
      } else if (isLastStepInSet && !isLastSet && nextLapIdx !== undefined) {
        const gap = sumLapsBetween(currentLapIdx, nextLapIdx);
        if (gap.count > 0) {
          derivedSetRecovery = Math.round(gap.movingTime);
          console.log(
            `${tag} set #${setIdx} set_recovery: ${gap.count} lap(s) -> ${derivedSetRecovery}s`,
          );
        }
      }

      globalStep++;
      return { ...step, target_pace, recovery_value, recovery_type };
    });

    return {
      ...set,
      set_recovery: derivedSetRecovery ?? set.set_recovery,
      steps: newSteps,
    };
  });

  return result;
}
