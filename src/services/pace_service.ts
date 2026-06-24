import { and, desc, eq } from "drizzle-orm";
import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { logger } from "../logger";
import { activities, intervalStructures } from "../schema";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import type { Lap } from "../types/strava/IDetailedActivity";
import {
  generateIntervalSignature,
  mapSetsToIntervalComponent,
} from "./interval_structure_service";
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
  const log = logger.child({ fn: "getProposedPaceForStructure" });
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

  log.info({ signature, matchingActivities: matchingActivities.length }, "signature lookup");

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
    log.info(
      {
        activityId: a.activityId,
        date: a.date.toISOString().split("T")[0],
        contributed: history.length - before,
      },
      "activity contributed INTERVALS rows",
    );
  }

  log.info({ rows: history.length }, "collected history rows total");
  if (history.length === 0) return completeIntervalSet;
  return interpolatePaces(history, completeIntervalSet);
};

// m/s for a history rep, or null when the row carries no usable pace (prefer an
// explicit targetPace; else distance/duration). A zero/garbage row returns null
// so it is EXCLUDED from averages rather than dragging them toward 0.
const getEffectivePace = (row: HistoryRow): number | null => {
  if (row.targetPace != null && row.targetPace > 0) return row.targetPace;
  if (row.actualDuration > 0 && row.actualDistance > 0) return row.actualDistance / row.actualDuration;
  return null;
};

// Unit-aware match tolerance: distance within max(50 m, 5%), time within
// max(5 s, 5%). A flat `< 1` was far too tight for time targets (90 s vs 91 s).
function targetsMatch(targetType: string, historyVal: number, stepVal: number): boolean {
  const tol = targetType === "distance" ? Math.max(50, stepVal * 0.05) : Math.max(5, stepVal * 0.05);
  return Math.abs(historyVal - stepVal) <= tol;
}

function meanOf(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  return valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
}

function interpolatePaces(rows: HistoryRow[], sets: ExpandedIntervalSet[]): ExpandedIntervalSet[] {
  const now = Date.now();
  return sets.map((set) => ({
    ...set,
    steps: set.steps.map((step) => {
      const targetType = step.work_type === "DISTANCE" ? "distance" : "time";
      // Match history rows to THIS step by target (type + value), never by
      // position: a flat positional counter misaligns identical reps and
      // interleaves rows from different activities. No same-shape history → no
      // proposal (null), rather than bleeding a different rep's or cross-type pace.
      const matching = rows.filter(
        (r) => r.targetType === targetType && targetsMatch(targetType, r.targetValue, step.work_value),
      );
      if (matching.length === 0) return { ...step, target_pace: null };
      // Recent fitness wins: use last-month matches if any, else all matches.
      const recent = matching.filter((r) => now - r.date.getTime() < ONE_MONTH_MS);
      const pool = recent.length > 0 ? recent : matching;
      return { ...step, target_pace: meanOf(pool.map(getEffectivePace)) };
    }),
  }));
}

export function getProposedPaceFromLaps(
  laps: Lap[],
  sets: z.infer<typeof workoutSet>[],
): ExpandedIntervalSet[] | null {
  const log = logger.child({ fn: "getProposedPaceFromLaps" });
  const tag = "[getProposedPaceFromLaps]";
  const expanded = generateCompleteIntervalSet(sets);
  log.info(
    {
      laps: laps.length,
      expectedWorkSteps: expanded.reduce((s, x) => s + x.steps.length, 0),
      structureSets: sets.length,
    },
    "starting",
  );
  log.debug(
    {
      laps: laps.map((l, i) => ({
        i,
        distance: l.distance,
        movingTime: l.moving_time,
        speed: Number(l.average_speed.toFixed(2)),
      })),
    },
    "laps detail",
  );

  const matchedLapIdx = matchLapsToExpandedSteps(laps, expanded, tag);
  if (!matchedLapIdx) return null;

  const matchedPaces = matchedLapIdx.map((i) => laps[i].average_speed);
  log.info(
    {
      steps: matchedPaces.length,
      pacesMps: matchedPaces.map((p) => Number(p.toFixed(2))),
    },
    "matched steps with paces",
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
          log.info(
            {
              step: globalStep,
              gapLaps: gap.count,
              recovery_value,
              unit: useDistance ? "m" : "s",
            },
            "step rest derived",
          );
        }
      } else if (isLastStepInSet && !isLastSet && nextLapIdx !== undefined) {
        const gap = sumLapsBetween(currentLapIdx, nextLapIdx);
        if (gap.count > 0) {
          derivedSetRecovery = Math.round(gap.movingTime);
          log.info(
            { setIdx, gapLaps: gap.count, set_recovery: derivedSetRecovery },
            "set_recovery derived",
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
