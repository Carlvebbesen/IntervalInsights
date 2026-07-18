// Deterministic, fully-synthetic training corpus for the store-review demo
// account. Pure module: `buildDemoCorpus(now)` derives every date from `now` and
// uses a fixed-seed PRNG, so the same `now` always yields an identical corpus.
// A later wave serves this data through the provider-read services, so the
// exported shapes are kept type-compatible with those services.

import type { z } from "zod";
import type { InsertActivity } from "../../schema/activities";
import type { TargetTypeEnum, TrainingType, WorkoutPartType } from "../../schema/enums";
import type { InsertEvent } from "../../schema/events";
import type { InsertGear } from "../../schema/gears";
import type { InsertIntervalSegment } from "../../schema/interval_segments";
import type { HrZoneSchema } from "../../schemas/dashboard_schemas";
import type { HrvStatus, IFitnessPoint, IHrvBaseline } from "../../types/intervals/IFitness";
import type {
  IIntervalsMetricStats,
  IIntervalsTrainingSummary,
  IIntervalsWeekWellness,
  IIntervalsWellnessPoint,
  IIntervalsWellnessSeries,
  IIntervalsWellnessSummary,
  NumericMetric,
} from "../../types/intervals/IIntervalsWellness";
import type { Lap, SplitMetrics } from "../../types/strava/IDetailedActivity";
import type { BestEffortCurve } from "../intervals_curve_service";

type Zone = z.infer<typeof HrZoneSchema>;

export type DemoActivityColumns = Omit<
  InsertActivity,
  "id" | "userId" | "createdAt" | "localGearId" | "intervalStructureId"
>;

export type DemoSegment = Omit<InsertIntervalSegment, "id" | "activityId">;

export interface DemoStreams {
  time: number[];
  distance: number[];
  heartrate: number[] | null;
  altitude: number[] | null;
  cadence: number[] | null;
  velocity: number[] | null;
}

export interface DemoActivity {
  demoKey: string;
  dayOffset: number;
  /** Index into `DemoCorpus.gears`, or null. */
  gearRef: number | null;
  /** Links to a `DemoStructure.signature`, or null for unstructured runs. */
  structureSignature: string | null;
  columns: DemoActivityColumns;
  streams: DemoStreams;
  laps: Lap[];
  splits: SplitMetrics[];
  segments: DemoSegment[];
}

export interface DemoStructure {
  name: string;
  signature: string;
}

export type DemoGear = Omit<InsertGear, "id" | "userId" | "createdAt">;

export interface DemoEvent {
  event: Omit<InsertEvent, "id" | "userId" | "createdAt" | "updatedAt">;
  activityDemoKeys: string[];
}

export interface DemoCorpus {
  activities: DemoActivity[];
  structures: DemoStructure[];
  gears: DemoGear[];
  events: DemoEvent[];
  fitnessSeries: IFitnessPoint[];
  wellnessSummary: IIntervalsWellnessSummary;
  trainingSummary: IIntervalsTrainingSummary;
  weekWellness: IIntervalsWeekWellness;
  wellnessSeries: IIntervalsWellnessSeries;
  curve: BestEffortCurve;
  hrZones: Zone[];
}

// ─── PRNG + small numeric helpers ─────────────────────────────────────────────

const SEED = 0x5eed_1234;
const DAY_MS = 86_400_000;
const WEEKS = 11;
const SPAN_DAYS = WEEKS * 7; // 77
const MAX_HR = 190;
const STREAM_DT = 5; // seconds between stream samples
const SHOE_RETIRE_M = 800_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const round = (x: number): number => Math.round(x);
const round1 = (x: number): number => Math.round(x * 10) / 10;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function stats(values: number[]): { avg: number; max: number; median: number; mode: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const counts = new Map<number, number>();
  let mode = sorted[0];
  let best = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > best) {
      best = c;
      mode = v;
    }
  }
  return { avg, max: sorted[sorted.length - 1], median, mode };
}

// ─── Session model ────────────────────────────────────────────────────────────

type Kind = "recovery" | "easy" | "long" | "tempo" | "intervals_short" | "intervals_long";

const TRAINING_TYPE: Record<Kind, TrainingType> = {
  recovery: "RECOVERY",
  easy: "EASY",
  long: "LONG",
  tempo: "TEMPO",
  intervals_short: "SHORT_INTERVALS",
  intervals_long: "LONG_INTERVALS",
};

const TITLE: Record<Kind, string> = {
  recovery: "Recovery jog",
  easy: "Easy run",
  long: "Long run",
  tempo: "Tempo run",
  intervals_short: "Short intervals",
  intervals_long: "Long intervals",
};

interface Block {
  durationSec: number;
  speed: number; // m/s
  hr: number; // target bpm
  kind: "warmup" | "steady" | "work" | "rest" | "cooldown";
  targetType?: TargetTypeEnum;
  targetValue?: number;
  targetPace?: number | null;
}

function steadyBlocks(totalSec: number, speed: number, hr: number): Block[] {
  const chunk = 900;
  const blocks: Block[] = [];
  let remaining = totalSec;
  while (remaining > 0) {
    const d = Math.min(chunk, remaining);
    blocks.push({ durationSec: d, speed, hr, kind: "steady" });
    remaining -= d;
  }
  return blocks;
}

function intervalBlocks(
  reps: number,
  workSec: number,
  restSec: number,
  workSpeed: number,
  workHr: number,
): { blocks: Block[]; repDistance: number } {
  const repDistance = round(workSpeed * workSec);
  const blocks: Block[] = [{ durationSec: 600, speed: 2.9, hr: 130, kind: "warmup" }];
  for (let i = 0; i < reps; i++) {
    blocks.push({
      durationSec: workSec,
      speed: workSpeed,
      hr: workHr,
      kind: "work",
      targetType: "distance",
      targetValue: repDistance,
      targetPace: round1(workSpeed),
    });
    if (i < reps - 1) {
      blocks.push({ durationSec: restSec, speed: 2.4, hr: 148, kind: "rest" });
    }
  }
  blocks.push({ durationSec: 600, speed: 2.85, hr: 135, kind: "cooldown" });
  return { blocks, repDistance };
}

function blocksFor(kind: Kind, progress: number, rng: () => number): Block[] {
  const jitter = (amp: number) => (rng() * 2 - 1) * amp;
  switch (kind) {
    case "recovery":
      return steadyBlocks(1800, 2.7, 132);
    case "easy":
      return steadyBlocks(round(2700 * (0.9 + 0.2 * progress)), 3.0, 145);
    case "long":
      return steadyBlocks(round(5400 + 1800 * progress + jitter(300)), 2.95, 152);
    case "tempo":
      return [
        { durationSec: 600, speed: 2.9, hr: 135, kind: "warmup" },
        ...steadyBlocks(round(1800 * (0.9 + 0.2 * progress)), 3.55, 168),
        { durationSec: 600, speed: 2.85, hr: 140, kind: "cooldown" },
      ];
    case "intervals_short":
      return intervalBlocks(8 + (progress > 0.5 ? 2 : 0), 90, 90, 4.3, 182).blocks;
    case "intervals_long":
      return intervalBlocks(5, 240, 120, 3.95, 178).blocks;
  }
}

function structureFor(kind: Kind, blocks: Block[]): DemoStructure | null {
  if (kind !== "intervals_short" && kind !== "intervals_long") return null;
  const workBlocks = blocks.filter((b) => b.kind === "work");
  const reps = workBlocks.length;
  const dist = workBlocks[0]?.targetValue ?? 0;
  const name = `${reps}x${dist}m`;
  return { name, signature: `demo-${kind}-${reps}x${dist}` };
}

// ─── Stream generation ────────────────────────────────────────────────────────

interface GeneratedStreams {
  streams: DemoStreams;
  sampleKind: Block["kind"][];
  movingTime: number;
  distanceM: number;
}

function generateStreams(blocks: Block[], rng: () => number): GeneratedStreams {
  const bounds: { end: number; block: Block }[] = [];
  let acc = 0;
  for (const b of blocks) {
    acc += b.durationSec;
    bounds.push({ end: acc, block: b });
  }
  const total = acc;

  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  const cadence: number[] = [];
  const velocity: number[] = [];
  const altitude: number[] = [];
  const sampleKind: Block["kind"][] = [];

  let cumDist = 0;
  let bi = 0;
  for (let t = 0; t <= total; t += STREAM_DT) {
    while (bi < bounds.length - 1 && t > bounds[bi].end) bi++;
    const block = bounds[bi].block;

    const warm = t < 420 ? t / 420 : 1;
    const cardiacDrift = 0.0015 * t;
    const hrTarget = 88 + (block.hr - 88) * warm + cardiacDrift + (rng() * 2 - 1) * 3;
    const hr = round(clamp(hrTarget, 80, 198));

    const v = Math.max(0.5, block.speed + (rng() * 2 - 1) * 0.15);
    cumDist += v * STREAM_DT;

    const cad = round(86 + (block.kind === "work" ? 6 : 0) + (rng() * 2 - 1) * 3);
    const alt = round1(40 + 8 * Math.sin(t / 300) + (rng() * 2 - 1) * 1.5);

    time.push(t);
    distance.push(round(cumDist));
    heartrate.push(hr);
    cadence.push(cad);
    velocity.push(round1(v));
    altitude.push(alt);
    sampleKind.push(block.kind);
  }

  return {
    streams: { time, distance, heartrate, cadence, velocity, altitude },
    sampleKind,
    movingTime: total,
    distanceM: round(cumDist),
  };
}

// ─── Laps / splits / segments ─────────────────────────────────────────────────

function makeLap(
  activityStravaId: number,
  index: number,
  startDate: string,
  seg: { distance: number; movingTime: number; avgHr: number; avgSpeed: number },
): Lap {
  return {
    id: activityStravaId * 100 + index,
    resource_state: 2,
    name: `Lap ${index + 1}`,
    activity: { id: activityStravaId, resource_state: 1 },
    athlete: { id: 0, resource_state: 1 },
    elapsed_time: seg.movingTime,
    moving_time: seg.movingTime,
    start_date: startDate,
    start_date_local: startDate,
    distance: seg.distance,
    start_index: 0,
    end_index: 0,
    total_elevation_gain: 0,
    average_speed: round1(seg.avgSpeed),
    max_speed: round1(seg.avgSpeed * 1.1),
    average_cadence: 88,
    device_watts: false,
    average_watts: 0,
    average_heartrate: seg.avgHr,
    max_heartrate: round(seg.avgHr + 6),
    lap_index: index + 1,
    split: index + 1,
  };
}

function buildLaps(
  blocks: Block[],
  gen: GeneratedStreams,
  stravaId: number,
  startDate: string,
): Lap[] {
  const laps: Lap[] = [];
  let sampleStart = 0;
  let blockStartTime = 0;
  blocks.forEach((b, i) => {
    const endTime = blockStartTime + b.durationSec;
    const samples: number[] = [];
    let s = sampleStart;
    while (s < gen.streams.time.length && gen.streams.time[s] <= endTime) {
      samples.push(s);
      s++;
    }
    if (samples.length > 0) {
      const hrSlice = samples.map((k) => gen.streams.heartrate?.[k] ?? 0);
      const vSlice = samples.map((k) => gen.streams.velocity?.[k] ?? 0);
      const dStart = gen.streams.distance[samples[0]];
      const dEnd = gen.streams.distance[samples[samples.length - 1]];
      laps.push(
        makeLap(stravaId, i, startDate, {
          distance: dEnd - dStart,
          movingTime: b.durationSec,
          avgHr: round(hrSlice.reduce((a, c) => a + c, 0) / hrSlice.length),
          avgSpeed: vSlice.reduce((a, c) => a + c, 0) / vSlice.length,
        }),
      );
    }
    sampleStart = s;
    blockStartTime = endTime;
  });
  return laps;
}

function buildSplits(gen: GeneratedStreams): SplitMetrics[] {
  const { time, distance, heartrate, velocity } = gen.streams;
  const splits: SplitMetrics[] = [];
  let nextKm = 1000;
  let startIdx = 0;
  let split = 1;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] >= nextKm) {
      const hrSlice = heartrate ? heartrate.slice(startIdx, i + 1) : [];
      const vSlice = velocity ? velocity.slice(startIdx, i + 1) : [];
      const avgSpeed = vSlice.length ? vSlice.reduce((a, c) => a + c, 0) / vSlice.length : 0;
      splits.push({
        distance: 1000,
        elapsed_time: time[i] - time[startIdx],
        elevation_difference: 0,
        moving_time: time[i] - time[startIdx],
        split,
        average_speed: round1(avgSpeed),
        average_grade_adjusted_speed: round1(avgSpeed),
        average_heartrate: hrSlice.length
          ? round(hrSlice.reduce((a, c) => a + c, 0) / hrSlice.length)
          : 0,
        pace_zone: 2,
      });
      split++;
      startIdx = i;
      nextKm += 1000;
    }
  }
  return splits;
}

function buildSegments(blocks: Block[], gen: GeneratedStreams): DemoSegment[] {
  const segments: DemoSegment[] = [];
  let blockStartTime = 0;
  let sampleStart = 0;
  let segmentIndex = 0;
  for (const b of blocks) {
    const endTime = blockStartTime + b.durationSec;
    const samples: number[] = [];
    let s = sampleStart;
    while (s < gen.streams.time.length && gen.streams.time[s] <= endTime) {
      samples.push(s);
      s++;
    }
    const hrSlice = samples.map((k) => gen.streams.heartrate?.[k] ?? 0);
    const avgHr = hrSlice.length
      ? round(hrSlice.reduce((a, c) => a + c, 0) / hrSlice.length)
      : null;
    const dStart = gen.streams.distance[samples[0] ?? 0] ?? 0;
    const dEnd = gen.streams.distance[samples[samples.length - 1] ?? 0] ?? 0;

    const type: WorkoutPartType =
      b.kind === "warmup"
        ? "WARMUP"
        : b.kind === "cooldown"
          ? "COOL_DOWN"
          : b.kind === "work"
            ? "INTERVALS"
            : "REST";

    segments.push({
      segmentIndex,
      setGroupIndex: 0,
      type,
      targetType: b.targetType ?? "time",
      targetValue: b.targetValue ?? b.durationSec,
      targetPace: b.targetPace ?? null,
      timeSeriesEndTime: endTime,
      actualDistance: Math.max(0, dEnd - dStart),
      actualDuration: b.durationSec,
      avgHeartRate: avgHr,
      recoveryTargetType: null,
      recoveryTargetValue: null,
      recoveryEndTime: null,
      recoveryDistance: null,
      recoveryDuration: null,
      recoveryAvgHeartRate: null,
    });
    segmentIndex++;
    blockStartTime = endTime;
    sampleStart = s;
  }
  return segments;
}

// ─── Weekly plan ──────────────────────────────────────────────────────────────

interface PlannedSession {
  kind: Kind;
  dayOffset: number;
}

function planSessions(): PlannedSession[] {
  const sessions: PlannedSession[] = [];
  for (let w = 0; w < WEEKS; w++) {
    // w = 0 oldest week … WEEKS-1 newest. weekBase = offset of that week's Monday.
    const weekBase = (WEEKS - 1 - w) * 7 + 6;
    const add = (kind: Kind, dayIdx: number) => {
      const off = weekBase - dayIdx;
      if (off >= 1) sessions.push({ kind, dayOffset: off });
    };
    add(w % 2 === 0 ? "intervals_short" : "intervals_long", 1); // Tue
    add("easy", 3); // Thu
    add("long", 6); // Sun
    if (w % 2 === 1) add("tempo", 5); // Sat
    if (w % 3 === 0) add("recovery", 0); // Mon
  }
  return sessions.sort((a, b) => b.dayOffset - a.dayOffset);
}

const TRAINING_LOAD: Record<Kind, number> = {
  recovery: 28,
  easy: 48,
  long: 120,
  tempo: 72,
  intervals_short: 85,
  intervals_long: 96,
};

// ─── Wellness / fitness series ────────────────────────────────────────────────

interface Daily {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  ctlLoad: number;
  atlLoad: number;
  rampRate: number;
  hrv: number;
  hrv7dAvg: number;
  hrvStatus: HrvStatus;
  hrvBaseline: IHrvBaseline | null;
  sleepScore: number;
  sleepSecs: number;
  sleepQuality: number;
  restingHR: number;
  readiness: number;
  fatigue: number;
  stress: number;
  mood: number;
  motivation: number;
  soreness: number;
  weight: number;
  vo2max: number;
}

function classify(rollingAvg: number, b: IHrvBaseline): "balanced" | "unbalanced" {
  return rollingAvg < b.lowerBalanced || rollingAvg > b.upperBalanced ? "unbalanced" : "balanced";
}

function buildDaily(now: Date, loadByOffset: Map<number, number>, rng: () => number): Daily[] {
  const daily: Daily[] = [];
  let ctl = 35;
  let atl = 35;
  const kCtl = 1 - Math.exp(-1 / 42);
  const kAtl = 1 - Math.exp(-1 / 7);
  const hrvHistory: number[] = [];
  const ctlHistory: number[] = [];

  for (let off = SPAN_DAYS; off >= 0; off--) {
    const load = loadByOffset.get(off) ?? 0;
    ctl = ctl + (load - ctl) * kCtl;
    atl = atl + (load - atl) * kAtl;
    ctlHistory.push(ctl);
    const rampRate = ctlHistory.length > 7 ? ctl - ctlHistory[ctlHistory.length - 8] : 0;

    const hrv = round(62 + 6 * Math.sin(off / 9) + (rng() * 2 - 1) * 3 - (load > 90 ? 4 : 0));
    hrvHistory.push(hrv);
    const recent = hrvHistory.slice(-7);
    const hrv7dAvg = round1(recent.reduce((a, c) => a + c, 0) / recent.length);

    let hrvBaseline: IHrvBaseline | null = null;
    let hrvStatus: HrvStatus = null;
    if (hrvHistory.length >= 21) {
      const window = hrvHistory.slice(-90);
      const mean = window.reduce((a, c) => a + c, 0) / window.length;
      const sd = Math.sqrt(window.reduce((a, c) => a + (c - mean) ** 2, 0) / window.length);
      hrvBaseline = {
        mean: round1(mean),
        lowerBalanced: round1(mean - sd),
        upperBalanced: round1(mean + sd),
      };
      hrvStatus = classify(hrv7dAvg, hrvBaseline);
    }

    daily.push({
      date: iso(new Date(now.getTime() - off * DAY_MS)),
      load,
      ctl: round1(ctl),
      atl: round1(atl),
      ctlLoad: round1(load),
      atlLoad: round1(load),
      rampRate: round1(rampRate),
      hrv,
      hrv7dAvg,
      hrvStatus,
      hrvBaseline,
      sleepScore: round(clamp(78 + (rng() * 2 - 1) * 8, 50, 100)),
      sleepSecs: round(25200 + (rng() * 2 - 1) * 3600),
      sleepQuality: round(clamp(3 + (rng() * 2 - 1), 1, 4)),
      restingHR: round(46 + (rng() * 2 - 1) * 2 + (load > 90 ? 2 : 0)),
      readiness: round(clamp(70 + (ctl - atl) + (rng() * 2 - 1) * 6, 1, 100)),
      fatigue: round(clamp(2 + (load > 90 ? 1 : 0) + (rng() * 2 - 1), 1, 4)),
      stress: round(clamp(2 + (rng() * 2 - 1), 1, 4)),
      mood: round(clamp(3 + (rng() * 2 - 1), 1, 4)),
      motivation: round(clamp(3 + (rng() * 2 - 1), 1, 4)),
      soreness: round(clamp(2 + (rng() * 2 - 1), 1, 4)),
      weight: round1(72 + (rng() * 2 - 1) * 0.6),
      vo2max: round1(54 + off / -80),
    });
  }
  return daily;
}

const METRIC_READERS: Record<NumericMetric, (d: Daily) => number | null> = {
  ctl: (d) => d.ctl,
  atl: (d) => d.atl,
  tsb: (d) => d.ctl - d.atl,
  rampRate: (d) => d.rampRate,
  ctlLoad: (d) => d.ctlLoad,
  atlLoad: (d) => d.atlLoad,
  sleepSecs: (d) => d.sleepSecs,
  sleepScore: (d) => d.sleepScore,
  sleepQuality: (d) => d.sleepQuality,
  restingHR: (d) => d.restingHR,
  hrv: (d) => d.hrv,
  readiness: (d) => d.readiness,
  baevskySI: () => null,
  spO2: () => null,
  respiration: () => null,
  soreness: (d) => d.soreness,
  fatigue: (d) => d.fatigue,
  stress: (d) => d.stress,
  mood: (d) => d.mood,
  motivation: (d) => d.motivation,
  injury: () => null,
  sickness: () => null,
  weight: (d) => d.weight,
  bodyFat: () => null,
  vo2max: (d) => d.vo2max,
};

const NUMERIC_METRICS = Object.keys(METRIC_READERS) as NumericMetric[];

function toWellnessPoint(d: Daily): IIntervalsWellnessPoint {
  return {
    date: d.date,
    fitness: {
      ctl: d.ctl,
      atl: d.atl,
      tsb: d.ctl - d.atl,
      rampRate: d.rampRate,
      ctlLoad: d.ctlLoad,
      atlLoad: d.atlLoad,
    },
    sleep: { sleepSecs: d.sleepSecs, sleepScore: d.sleepScore, sleepQuality: d.sleepQuality },
    recovery: {
      restingHR: d.restingHR,
      hrv: d.hrv,
      readiness: d.readiness,
      baevskySI: null,
      spO2: null,
      respiration: null,
    },
    subjective: {
      soreness: d.soreness,
      fatigue: d.fatigue,
      stress: d.stress,
      mood: d.mood,
      motivation: d.motivation,
    },
    health: { injury: null, sickness: null },
    body: { weight: d.weight, bodyFat: null, vo2max: d.vo2max },
    comments: null,
  };
}

function buildWellnessSeries(daily: Daily[]): IIntervalsWellnessSeries {
  const last = daily[daily.length - 1];
  const summary = {} as Record<NumericMetric, IIntervalsMetricStats>;
  const metricsAvailable: NumericMetric[] = [];
  for (const key of NUMERIC_METRICS) {
    let min: number | null = null;
    let max: number | null = null;
    let sum = 0;
    let count = 0;
    for (const d of daily) {
      const v = METRIC_READERS[key](d);
      if (v == null) continue;
      if (min == null || v < min) min = v;
      if (max == null || v > max) max = v;
      sum += v;
      count++;
    }
    summary[key] = {
      latest: METRIC_READERS[key](last),
      min,
      max,
      avg: count > 0 ? round1(sum / count) : null,
    };
    if (count > 0) metricsAvailable.push(key);
  }
  return {
    range: { oldest: daily[0].date, newest: last.date },
    metricsAvailable,
    summary,
    points: daily.map(toWellnessPoint),
  };
}

// ─── HR zones + best-effort curve ─────────────────────────────────────────────

const ZONE_PALETTE = ["#22C55E", "#3B82F6", "#F59E0B", "#EF4444", "#7C3AED"];

function buildHrZones(): Zone[] {
  const uppers = [0.6, 0.7, 0.8, 0.9, 1.0].map((f) => round(MAX_HR * f));
  const zones: Zone[] = [];
  let prev = 0;
  uppers.forEach((u, i) => {
    zones.push({ label: `Z${i + 1}`, min: prev, max: u, color: ZONE_PALETTE[i] });
    prev = u;
  });
  return zones;
}

const CURVE_POINTS: { durationSecs: number; label: string; value: number }[] = [
  { durationSecs: 5, label: "5s", value: 6.4 },
  { durationSecs: 15, label: "15s", value: 6.0 },
  { durationSecs: 30, label: "30s", value: 5.7 },
  { durationSecs: 60, label: "1m", value: 5.4 },
  { durationSecs: 120, label: "2m", value: 5.1 },
  { durationSecs: 300, label: "5m", value: 4.7 },
  { durationSecs: 600, label: "10m", value: 4.4 },
  { durationSecs: 1200, label: "20m", value: 4.1 },
  { durationSecs: 1800, label: "30m", value: 3.9 },
  { durationSecs: 3600, label: "60m", value: 3.6 },
  { durationSecs: 5400, label: "90m", value: 3.4 },
];

// ─── Assembly ─────────────────────────────────────────────────────────────────

export function buildDemoCorpus(now: Date): DemoCorpus {
  const rng = mulberry32(SEED);

  const gears: DemoGear[] = [
    {
      gearType: "SHOES",
      brand: "Demo",
      model: "Tempo Trainer",
      nickname: "Daily miles",
      surface: "ROAD",
      useTypes: ["EASY", "LONG", "RECOVERY"],
      isActive: true,
      retiredAt: null,
      stravaGearId: null,
      // Near the ~800 km retirement threshold so the mileage feature surfaces.
      baselineDistanceMeters: SHOE_RETIRE_M - 90_000,
      baselineDate: new Date(now.getTime() - 200 * DAY_MS),
      maintainedDistanceMeters: 0,
      activityCount: 0,
    },
    {
      gearType: "SHOES",
      brand: "Demo",
      model: "Speed Racer",
      nickname: "Workout shoes",
      surface: "ROAD",
      useTypes: ["SHORT_INTERVALS", "LONG_INTERVALS", "TEMPO"],
      isActive: true,
      retiredAt: null,
      stravaGearId: null,
      baselineDistanceMeters: 120_000,
      baselineDate: new Date(now.getTime() - 60 * DAY_MS),
      maintainedDistanceMeters: 0,
      activityCount: 0,
    },
  ];

  const planned = planSessions();
  const activities: DemoActivity[] = [];
  const structureBySig = new Map<string, DemoStructure>();
  const loadByOffset = new Map<number, number>();

  planned.forEach((session, idx) => {
    const { kind, dayOffset } = session;
    const progress = (WEEKS - Math.ceil(dayOffset / 7)) / WEEKS;
    const blocks = blocksFor(kind, clamp(progress, 0, 1), rng);
    const gen = generateStreams(blocks, rng);

    const demoKey = `demo-${String(idx + 1).padStart(4, "0")}`;
    const structure = structureFor(kind, blocks);
    if (structure) structureBySig.set(structure.signature, structure);
    const isInterval = kind === "intervals_short" || kind === "intervals_long";
    const segments = isInterval ? buildSegments(blocks, gen) : [];

    const startDate = new Date(now.getTime() - dayOffset * DAY_MS);
    const startDateLocal = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
        7,
        0,
        0,
      ),
    );
    const isoStart = startDateLocal.toISOString();
    const stravaLikeId = 900_000 + idx; // stable id used only inside laps

    const full = stats(gen.streams.heartrate ?? []);
    const workSamples = gen.sampleKind
      .map((k, i) => (k === "work" ? (gen.streams.heartrate?.[i] ?? null) : null))
      .filter((v): v is number => v != null);
    const work = workSamples.length > 0 ? stats(workSamples) : null;

    const load = round(TRAINING_LOAD[kind] + (rng() * 2 - 1) * 8);
    loadByOffset.set(dayOffset, (loadByOffset.get(dayOffset) ?? 0) + load);

    const gearRef = isInterval || kind === "tempo" ? 1 : 0;

    const columns: DemoActivityColumns = {
      trainingType: TRAINING_TYPE[kind],
      analysisStatus: "completed",
      analysisAttemptCount: 0,
      analysisVersion: "v1.0",
      stravaActivityId: null,
      gearUpdatedFromStrava: false,
      hasHeartrate: true,
      title: TITLE[kind],
      sportType: "Run",
      distance: gen.distanceM,
      movingTime: gen.movingTime,
      elapsedTime: gen.movingTime + 30,
      totalElevationGain: 40,
      averageHeartRate: round1(full.avg),
      maxHeartRate: full.max,
      medianHeartRate: full.median,
      modeHeartRate: full.mode,
      workAvgHeartRate: work ? round(work.avg) : null,
      workMaxHeartRate: work ? work.max : null,
      workMedianHeartRate: work ? work.median : null,
      workModeHeartRate: work ? work.mode : null,
      hrStatsComputedAt: startDateLocal,
      startDateLocal,
      indoor: false,
      intervalsIcuId: demoKey,
      intervalsAnalyzed: true,
      trainingLoad: load,
      icuTrainingLoad: load,
      // icuCtl / icuAtl patched below once the daily series is computed.
      icuCtl: null,
      icuAtl: null,
    };

    activities.push({
      demoKey,
      dayOffset,
      gearRef,
      structureSignature: structure?.signature ?? null,
      columns,
      streams: gen.streams,
      laps: buildLaps(blocks, gen, stravaLikeId, isoStart),
      splits: buildSplits(gen),
      segments,
    });
  });

  const daily = buildDaily(now, loadByOffset, rng);
  const ctlByDate = new Map(daily.map((d) => [d.date, d]));
  for (const a of activities) {
    const d = ctlByDate.get(iso(a.columns.startDateLocal as Date));
    if (d) {
      a.columns.icuCtl = d.ctl;
      a.columns.icuAtl = d.atl;
    }
  }

  const fitnessSeries: IFitnessPoint[] = daily.map((d) => ({
    date: d.date,
    ctl: d.ctl,
    atl: d.atl,
    tsb: round1(d.ctl - d.atl),
    ctlLoad: d.ctlLoad,
    atlLoad: d.atlLoad,
    hrv: d.hrv,
    hrv7dAvg: d.hrv7dAvg,
    hrvStatus: d.hrvStatus,
    hrvNightlyStatus: d.hrvBaseline ? classify(d.hrv, d.hrvBaseline) : null,
    hrvBaseline: d.hrvBaseline,
    sleepScore: d.sleepScore,
  }));

  const last = daily[daily.length - 1];
  const last7 = daily.slice(-7);
  const hrvAll = daily.map((d) => d.hrv);
  const sleepQualityAll = daily.map((d) => d.sleepQuality);

  const wellnessSummary: IIntervalsWellnessSummary = {
    ctl: last.ctl,
    atl: last.atl,
    tsb: round1(last.ctl - last.atl),
    avgHrv: round1(hrvAll.reduce((a, c) => a + c, 0) / hrvAll.length),
    avgSleepQuality: round1(sleepQualityAll.reduce((a, c) => a + c, 0) / sleepQualityAll.length),
    restingHr: last.restingHR,
  };

  const trainingSummary: IIntervalsTrainingSummary = {
    date: last.date,
    fitness: {
      ctl: last.ctl,
      atl: last.atl,
      rampRate: last.rampRate,
      ctlLoad: last.ctlLoad,
      atlLoad: last.atlLoad,
    },
    sleep: { sleepSecs: last.sleepSecs, sleepScore: last.sleepScore },
    recovery: {
      restingHR: last.restingHR,
      hrv: last.hrv,
      readiness: last.readiness,
      baevskySI: null,
      spO2: null,
      respiration: null,
    },
    body: { weight: last.weight, vo2max: last.vo2max },
  };

  const weekWellness: IIntervalsWeekWellness = {
    avgSleepScore: round1(last7.reduce((a, c) => a + c.sleepScore, 0) / last7.length),
    avgFatigue: round1(last7.reduce((a, c) => a + c.fatigue, 0) / last7.length),
    fitness: last.ctl,
    form: round1(last.ctl - last.atl),
    totalLoad: round(last7.reduce((a, c) => a + c.atlLoad, 0)),
  };

  const curve: BestEffortCurve = {
    type: "Run",
    window: "this_season",
    unit: "value",
    points: CURVE_POINTS.map((p) => ({ ...p })),
  };

  const events: DemoEvent[] = [];
  if (activities.length >= 6) {
    const injuryActs = activities.filter((a) => a.dayOffset >= 30 && a.dayOffset <= 45).slice(0, 2);
    if (injuryActs.length > 0) {
      events.push({
        event: {
          eventType: "INJURY",
          bodyLocation: "left calf",
          description: "Mild left calf tightness after a hard session — eased off for a few days.",
          startTime: new Date(now.getTime() - injuryActs[0].dayOffset * DAY_MS),
          lastOccurrence: new Date(
            now.getTime() - injuryActs[injuryActs.length - 1].dayOffset * DAY_MS,
          ),
          status: "resolved",
          resolvedAt: new Date(now.getTime() - 25 * DAY_MS),
        },
        activityDemoKeys: injuryActs.map((a) => a.demoKey),
      });
    }
    const illnessAct = activities.find((a) => a.dayOffset >= 10 && a.dayOffset <= 18);
    if (illnessAct) {
      events.push({
        event: {
          eventType: "ILLNESS",
          bodyLocation: null,
          description: "Head cold — kept runs easy for a week.",
          startTime: new Date(now.getTime() - illnessAct.dayOffset * DAY_MS),
          lastOccurrence: new Date(now.getTime() - illnessAct.dayOffset * DAY_MS),
          status: "resolved",
          resolvedAt: new Date(now.getTime() - 8 * DAY_MS),
        },
        activityDemoKeys: [illnessAct.demoKey],
      });
    }
  }

  return {
    activities,
    structures: [...structureBySig.values()],
    gears,
    events,
    fitnessSeries,
    wellnessSummary,
    trainingSummary,
    weekWellness,
    wellnessSeries: buildWellnessSeries(daily),
    curve,
    hrZones: buildHrZones(),
  };
}
