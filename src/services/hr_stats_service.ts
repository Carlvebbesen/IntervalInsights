import type { WorkoutPartType } from "../schema/enums";
import type { StreamSet } from "../types/strava/IStream";

/** The four HR distribution metrics the heart-rate analysis endpoint returns. */
export interface HrStats {
  avg: number;
  max: number;
  median: number;
  mode: number;
}

/** Segment shape needed to locate work-interval windows in the HR stream. */
export interface WorkWindowSegment {
  type: WorkoutPartType;
  timeSeriesEndTime: number;
  actualDuration: number;
}

/**
 * Segment types that count as "work" for `intervalsOnly`. Only the efforts
 * themselves — rest/recovery/warmup/cooldown/jogging are excluded.
 */
const WORK_SEGMENT_TYPES = new Set<WorkoutPartType>(["INTERVALS"]);

/**
 * Compute avg / max / median / mode from a list of HR samples (≈ 1 sample per
 * second). Zero/negative readings are dropped (Strava pads gaps with 0).
 * `mode` is the integer-bpm value the athlete spent the most samples at — i.e.
 * "most time in HR". Returns null when there are no usable samples.
 */
export function computeHrStats(hr: readonly number[]): HrStats | null {
  const values = hr.filter((h) => h > 0);
  if (values.length === 0) return null;

  let sum = 0;
  let max = 0;
  const counts = new Map<number, number>();
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
    const bpm = Math.round(v);
    counts.set(bpm, (counts.get(bpm) ?? 0) + 1);
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  let mode = 0;
  let bestCount = -1;
  for (const [bpm, count] of counts) {
    // Tie-break toward the lower bpm for determinism.
    if (count > bestCount || (count === bestCount && bpm < mode)) {
      bestCount = count;
      mode = bpm;
    }
  }

  return {
    avg: Math.round(sum / values.length),
    max: Math.round(max),
    median: Math.round(median),
    mode,
  };
}

/** Whole-activity HR stats straight from the heartrate stream. */
export function computeActivityHrStats(streams: Pick<StreamSet, "heartrate">): HrStats | null {
  return computeHrStats(streams.heartrate?.data ?? []);
}

/**
 * HR stats restricted to the work intervals. Slices the heartrate stream to the
 * time windows of work segments (`[timeSeriesEndTime - actualDuration,
 * timeSeriesEndTime]`) using the time stream, then computes stats over the
 * concatenated samples. Returns null when there are no work segments or no HR.
 */
export function computeWorkHrStats(
  streams: Pick<StreamSet, "time" | "heartrate">,
  segments: readonly WorkWindowSegment[],
): HrStats | null {
  const time = streams.time?.data;
  const hr = streams.heartrate?.data;
  if (!time || !hr || time.length === 0) return null;

  const workSamples: number[] = [];
  for (const seg of segments) {
    if (!WORK_SEGMENT_TYPES.has(seg.type)) continue;
    const end = seg.timeSeriesEndTime;
    const start = end - seg.actualDuration;
    for (let i = 0; i < time.length; i++) {
      const t = time[i];
      if (t < start) continue;
      if (t > end) break;
      const sample = hr[i];
      if (sample != null) workSamples.push(sample);
    }
  }

  return computeHrStats(workSamples);
}
