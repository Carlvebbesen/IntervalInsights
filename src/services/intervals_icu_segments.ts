import { logger } from "../logger";
import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import type { StreamSet } from "../types/strava/IStream";
import { calculateSegmentStats } from "./utils";

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

function isWork(iv: IIntervalsInterval): boolean {
  const t = (iv.type ?? "").toUpperCase();
  return t.includes("WORK") || t === "INTERVALS";
}

/**
 * Preferred segmentation rung when the activity is linked to intervals.icu:
 * intervals.icu already split the workout into WORK/RECOVERY blocks, so trust
 * that classification instead of re-deriving reps from speed/HR. The blocks are
 * a contiguous partition of the activity, so we lay them end-to-end from t0 by
 * `elapsed_time` (start_index is intervals.icu-relative and not comparable to the
 * Strava streams the app renders) and compute stats against the given streams.
 * Returns null when there's no WORK block, so the caller falls back to laps/LLM.
 *
 * Lives in its own module (not lap_derivation_service) to stay off that file's
 * heavy API-service import chain — it needs only stream stats.
 */
export function buildSegmentsFromIntervalsIcu(
  activityId: number,
  intervals: IIntervalsInterval[],
  streams: StatsStreams,
  parentTag = "",
  expectedReps?: number,
): InsertIntervalSegment[] | null {
  const tag = `${parentTag}[buildSegmentsFromIntervalsIcu]`;
  if (intervals.length === 0) return null;

  const firstWork = intervals.findIndex(isWork);
  const lastWork = intervals.reduce((acc, iv, i) => (isWork(iv) ? i : acc), -1);
  if (firstWork === -1) {
    logger.info({ tag }, "no WORK interval — falling through");
    return null;
  }

  // Only trust intervals.icu's breakdown when it's a credible rep-level partition.
  // intervals.icu's own detection often fails for HR/pace (esp. treadmill): it
  // returns a few coarse all-WORK lumps with no RECOVERY — laying those end-to-end
  // yields a 2-4 segment "interval" plan that hides the real reps. In that case
  // fall through to the deterministic segmenter (speed/HR), which recovers the reps.
  const workCount = intervals.filter(isWork).length;
  const recoveryCount = intervals.length - workCount;
  const minWork = expectedReps ? Math.max(2, Math.floor(expectedReps * 0.5)) : 2;
  const maxWork = expectedReps ? Math.ceil(expectedReps * 1.5) : Number.POSITIVE_INFINITY;
  if (recoveryCount === 0 || workCount < minWork || workCount > maxWork) {
    logger.info(
      { tag, workCount, recoveryCount, expectedReps, minWork, maxWork },
      "intervals.icu breakdown not a credible rep structure (no rests / too few or too many work blocks vs the structure) — falling through to heuristics",
    );
    return null;
  }

  const timeData = streams.time.data;
  const t0 = timeData[0] ?? 0;
  const tEnd = timeData[timeData.length - 1] ?? 0;

  const bounds: { start: number; end: number }[] = [];
  let cursor = t0;
  for (const iv of intervals) {
    const dur = iv.elapsed_time ?? iv.moving_time ?? 0;
    bounds.push({ start: cursor, end: cursor + dur });
    cursor += dur;
  }

  const segments: InsertIntervalSegment[] = [];
  let segmentIndex = 0;
  const push = (
    type: InsertIntervalSegment["type"],
    setGroupIndex: number,
    targetType: InsertIntervalSegment["targetType"],
    targetValue: number,
    start: number,
    end: number,
  ): void => {
    const stats = calculateSegmentStats(streams, start, end);
    if (!stats) return;
    segments.push({
      activityId,
      segmentIndex: segmentIndex++,
      setGroupIndex,
      type,
      targetType,
      targetValue,
      targetPace: null,
      timeSeriesEndTime: stats.timeSeriesEndTime,
      actualDistance: stats.actualDistance,
      actualDuration: stats.actualDuration,
      avgHeartRate: stats.avgHeartRate,
    });
  };

  if (bounds[firstWork].start > t0 + 1) {
    push("WARMUP", 0, "custom", 0, t0, bounds[firstWork].start);
  }
  for (let i = firstWork; i <= lastWork; i++) {
    const iv = intervals[i];
    const { start, end } = bounds[i];
    if (isWork(iv)) {
      const distanceTarget = (iv.distance ?? 0) > 0;
      push(
        "INTERVALS",
        1,
        distanceTarget ? "distance" : "time",
        distanceTarget ? Math.round(iv.distance) : (iv.elapsed_time ?? iv.moving_time ?? 0),
        start,
        end,
      );
    } else {
      push("REST", 1, "custom", 0, start, end);
    }
  }
  if (tEnd > bounds[lastWork].end + 1) {
    push("COOL_DOWN", 0, "custom", 0, bounds[lastWork].end, tEnd);
  }

  logger.info({ tag, segments: segments.length }, "built segments from intervals.icu");
  return segments.length > 0 ? segments : null;
}
