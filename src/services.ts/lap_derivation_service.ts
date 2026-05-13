import { asc, eq } from "drizzle-orm";
import type z from "zod";
import type { workoutSet } from "../agent/initial_analysis_agent";
import { getStravaAccessTokens } from "../middlewares/strava_middleware";
import { activities, intervalSegments } from "../schema";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import { stravaApiService } from "./strava_api_service";
import { calculateSegmentStats, generateCompleteIntervalSet } from "./utils";

const STREAM_KEYS = ["time", "distance", "heartrate"] as const;

export function matchLapsToExpandedSteps(
  laps: Lap[],
  expanded: ExpandedIntervalSet[],
  logTag = "[matchLapsToExpandedSteps]",
): number[] | null {
  const expectedWorkSteps = expanded.reduce((sum, set) => sum + set.steps.length, 0);
  if (expectedWorkSteps === 0 || laps.length < expectedWorkSteps) {
    console.log(`${logTag} bail: laps=${laps.length} < expectedWorkSteps=${expectedWorkSteps}`);
    return null;
  }

  const matchedLapIdx: number[] = [];
  let cursor = -1;
  let stepCounter = 0;

  for (const set of expanded) {
    for (const step of set.steps) {
      const targetIsDistance = step.work_type === "DISTANCE";
      const targetVal = step.work_value;
      const tolerance = targetIsDistance
        ? Math.max(50, targetVal * 0.15)
        : Math.max(5, targetVal * 0.15);

      let matchIdx = -1;
      for (let i = cursor + 1; i < laps.length; i++) {
        const lap = laps[i];
        const lapVal = targetIsDistance ? lap.distance : lap.moving_time;
        if (Math.abs(lapVal - targetVal) <= tolerance && lap.average_speed > 0) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx === -1) {
        console.log(
          `${logTag} step #${stepCounter} (${step.work_type}=${targetVal}, tol=±${tolerance}) NO MATCH after lap cursor=${cursor} — bailing`,
        );
        return null;
      }
      console.log(
        `${logTag} step #${stepCounter} (${step.work_type}=${targetVal}) -> lap #${matchIdx} (${targetIsDistance ? `${laps[matchIdx].distance}m` : `${laps[matchIdx].moving_time}s`}, speed=${laps[matchIdx].average_speed.toFixed(2)}m/s)`,
      );
      matchedLapIdx.push(matchIdx);
      cursor = matchIdx;
      stepCounter++;
    }
  }
  return matchedLapIdx;
}

export function structureShapeMatches(
  initial: z.infer<typeof workoutSet>[] | null | undefined,
  userSets: ExpandedIntervalSet[],
): boolean {
  const tag = "[structureShapeMatches]";
  if (!initial || initial.length === 0) {
    console.log(`${tag} no initial structure — not matching`);
    return false;
  }
  const expanded = generateCompleteIntervalSet(initial);
  if (expanded.length !== userSets.length) {
    console.log(
      `${tag} set count mismatch: initialExpanded=${expanded.length} userSets=${userSets.length}`,
    );
    return false;
  }
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    const b = userSets[i];
    if (a.steps.length !== b.steps.length) {
      console.log(
        `${tag} set #${i} step count mismatch: initial=${a.steps.length} user=${b.steps.length}`,
      );
      return false;
    }
    for (let j = 0; j < a.steps.length; j++) {
      const sa = a.steps[j];
      const sb = b.steps[j];
      if (sa.work_type !== sb.work_type || sa.work_value !== sb.work_value) {
        console.log(
          `${tag} set #${i} step #${j} differs: initial=${sa.work_type}=${sa.work_value} user=${sb.work_type}=${sb.work_value}`,
        );
        return false;
      }
    }
  }
  console.log(`${tag} match — ${expanded.length} sets × steps identical (paces/rests ignored)`);
  return true;
}

export function buildSegmentsFromLaps(
  activityId: number,
  laps: Lap[],
  userSets: ExpandedIntervalSet[],
  streams: Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">,
  parentTag = "",
): InsertIntervalSegment[] | null {
  const tag = `${parentTag}[buildSegmentsFromLaps]`;
  const matched = matchLapsToExpandedSteps(laps, userSets, tag);
  if (!matched) return null;

  const timeData = streams.time.data;
  const lapTime = (idx: number): { start: number; end: number } | null => {
    const lap = laps[idx];
    const startIdx = Math.min(lap.start_index, timeData.length - 1);
    const startSec = timeData[startIdx];
    const endSec = startSec + lap.elapsed_time;
    return { start: startSec, end: endSec };
  };

  const segments: InsertIntervalSegment[] = [];
  let segmentIndex = 0;
  let droppedByStats = 0;

  const firstWorkLapIdx = matched[0];
  if (firstWorkLapIdx > 0) {
    const warmupStart = lapTime(0)?.start;
    const warmupEnd = lapTime(firstWorkLapIdx - 1)?.end;
    if (warmupStart != null && warmupEnd != null) {
      const stats = calculateSegmentStats(streams, warmupStart, warmupEnd);
      if (stats) {
        segments.push({
          activityId,
          segmentIndex: segmentIndex++,
          setGroupIndex: 0,
          type: "WARMUP",
          targetType: "custom",
          targetValue: 0,
          targetPace: null,
          timeSeriesEndTime: stats.timeSeriesEndTime,
          actualDistance: stats.actualDistance,
          actualDuration: stats.actualDuration,
          avgHeartRate: stats.avgHeartRate,
        });
      } else {
        droppedByStats++;
      }
    }
  }

  let globalStep = 0;
  for (let setIdx = 0; setIdx < userSets.length; setIdx++) {
    const set = userSets[setIdx];
    for (let stepIdx = 0; stepIdx < set.steps.length; stepIdx++) {
      const step = set.steps[stepIdx];
      const workLapIdx = matched[globalStep];
      const workTimes = lapTime(workLapIdx);
      if (!workTimes) {
        droppedByStats++;
      } else {
        const stats = calculateSegmentStats(streams, workTimes.start, workTimes.end);
        if (stats) {
          segments.push({
            activityId,
            segmentIndex: segmentIndex++,
            setGroupIndex: setIdx + 1,
            type: "INTERVALS",
            targetType: step.work_type === "DISTANCE" ? "distance" : "time",
            targetValue: step.work_value,
            targetPace: step.target_pace ?? null,
            timeSeriesEndTime: stats.timeSeriesEndTime,
            actualDistance: stats.actualDistance,
            actualDuration: stats.actualDuration,
            avgHeartRate: stats.avgHeartRate,
          });
        } else {
          droppedByStats++;
        }
      }

      const nextWorkLapIdx = matched[globalStep + 1];
      if (nextWorkLapIdx !== undefined && nextWorkLapIdx > workLapIdx + 1) {
        const restStart = lapTime(workLapIdx + 1)?.start;
        const restEnd = lapTime(nextWorkLapIdx - 1)?.end;
        if (restStart != null && restEnd != null) {
          const stats = calculateSegmentStats(streams, restStart, restEnd);
          if (stats) {
            const isLastStepInSet = stepIdx === set.steps.length - 1;
            segments.push({
              activityId,
              segmentIndex: segmentIndex++,
              setGroupIndex: setIdx + 1,
              type: isLastStepInSet ? "ACTIVE_REST" : "REST",
              targetType: step.recovery_type === "DISTANCE" ? "distance" : "time",
              targetValue: step.recovery_value ?? 0,
              targetPace: null,
              timeSeriesEndTime: stats.timeSeriesEndTime,
              actualDistance: stats.actualDistance,
              actualDuration: stats.actualDuration,
              avgHeartRate: stats.avgHeartRate,
            });
          } else {
            droppedByStats++;
          }
        }
      }

      globalStep++;
    }
  }

  const lastWorkLapIdx = matched[matched.length - 1];
  if (lastWorkLapIdx < laps.length - 1) {
    const cooldownStart = lapTime(lastWorkLapIdx + 1)?.start;
    const cooldownEnd = lapTime(laps.length - 1)?.end;
    if (cooldownStart != null && cooldownEnd != null) {
      const stats = calculateSegmentStats(streams, cooldownStart, cooldownEnd);
      if (stats) {
        segments.push({
          activityId,
          segmentIndex: segmentIndex++,
          setGroupIndex: 0,
          type: "COOL_DOWN",
          targetType: "custom",
          targetValue: 0,
          targetPace: null,
          timeSeriesEndTime: stats.timeSeriesEndTime,
          actualDistance: stats.actualDistance,
          actualDuration: stats.actualDuration,
          avgHeartRate: stats.avgHeartRate,
        });
      } else {
        droppedByStats++;
      }
    }
  }

  console.log(`${tag} built ${segments.length} segments, droppedByStats=${droppedByStats}`);
  return segments;
}

export type StoredOrDerivedSegment =
  | typeof intervalSegments.$inferSelect
  | (InsertIntervalSegment & { id: number });

export async function getSegmentsForActivity(
  db: IGlobalBindings["db"],
  clerkUserId: string,
  activityId: number,
): Promise<StoredOrDerivedSegment[]> {
  const tag = `[getSegmentsForActivity activity=${activityId}]`;

  const stored = await db
    .select()
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, activityId))
    .orderBy(asc(intervalSegments.segmentIndex));

  if (stored.length > 0) {
    console.log(`${tag} returning ${stored.length} stored segments`);
    return stored;
  }

  const activity = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: {
      stravaActivityId: true,
      draftAnalysisResult: true,
      indoor: true,
    },
  });
  const draft = activity?.draftAnalysisResult;
  if (
    !activity ||
    activity.indoor ||
    !draft?.segmentsFromLaps ||
    !draft.acceptedSets ||
    draft.acceptedSets.length === 0
  ) {
    console.log(
      `${tag} not eligible for re-derivation (indoor=${activity?.indoor} flag=${draft?.segmentsFromLaps} acceptedSets=${draft?.acceptedSets?.length ?? 0})`,
    );
    return [];
  }

  try {
    const tokens = await getStravaAccessTokens(clerkUserId);
    const [laps, streams] = await Promise.all([
      stravaApiService.getActivityLaps(tokens.access_token, activity.stravaActivityId),
      stravaApiService.getActivityStreams(tokens.access_token, activity.stravaActivityId, [
        ...STREAM_KEYS,
      ]),
    ]);
    if (!streams?.time || !streams?.distance) {
      console.log(`${tag} re-derivation skipped: Strava streams missing time/distance`);
      return [];
    }
    const statsStreams = streams as Required<Pick<StreamSet, "time" | "distance">> &
      Pick<StreamSet, "heartrate">;
    const derived = buildSegmentsFromLaps(activityId, laps, draft.acceptedSets, statsStreams, tag);
    if (!derived) {
      console.log(`${tag} buildSegmentsFromLaps returned null on re-derivation`);
      return [];
    }
    console.log(`${tag} re-derived ${derived.length} segments from Strava`);
    return derived.map((seg, idx) => ({ ...seg, id: -(idx + 1) }));
  } catch (err) {
    console.error(`${tag} re-derivation failed:`, err);
    return [];
  }
}
