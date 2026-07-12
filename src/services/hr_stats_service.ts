import type { WorkoutPartType } from "../schema/enums";
import type { StreamSet } from "../types/strava/IStream";

export interface HrStats {
  avg: number;
  max: number;
  median: number;
  mode: number;
}

export interface WorkWindowSegment {
  type: WorkoutPartType;
  timeSeriesEndTime: number;
  actualDuration: number;
}

const WORK_SEGMENT_TYPES = new Set<WorkoutPartType>(["INTERVALS"]);

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

export function computeActivityHrStats(streams: Pick<StreamSet, "heartrate">): HrStats | null {
  return computeHrStats(streams.heartrate?.data ?? []);
}

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
