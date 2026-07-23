import { RUNNING_SPORT_TYPES } from "../schema/enums";

/**
 * Pure per-activity training-load math. No DB, no I/O — the caller resolves
 * thresholds (see `threshold_service`) and maps raw streams into `LoadStreams`.
 * All loads normalise to "1 hour at threshold = 100". Pace and power integrate
 * over moving time; HRSS integrates over all recorded time (see `hrss`).
 * Formulas: `knowledge/resources/recipes/training-metrics-formulas.md`.
 */

export interface LoadStreams {
  /** Elapsed seconds per sample. Drives dt and gap detection. */
  time: number[];
  /** Speed, m/s. */
  velocity?: (number | null)[] | null;
  /** Altitude, m (for grade-adjusted pace). */
  altitude?: (number | null)[] | null;
  /** Cumulative distance, m (for grade computation). */
  distance?: (number | null)[] | null;
  /** Heart rate, bpm. */
  heartrate?: (number | null)[] | null;
  /** Power, watts. */
  watts?: (number | null)[] | null;
  /** Moving flag per sample; when absent, velocity < 0.3 m/s = stopped. */
  moving?: (boolean | null)[] | null;
}

export type Sex = "male" | "female";

export interface HrssParams {
  lthr: number | null;
  restingHr: number | null;
  maxHr: number | null;
  sex?: Sex | null;
}

export interface ActivityThresholds {
  thresholdPaceMps: number | null;
  lthr: number | null;
  restingHr: number | null;
  maxHr: number | null;
  ftp: number | null;
  sex?: Sex | null;
}

export interface ComputeActivityLoadInput {
  sportType: string;
  streams: LoadStreams;
  thresholds: ActivityThresholds;
}

export type LoadSource = "power" | "pace" | "hr";

export interface ActivityLoadResult {
  load: number;
  source: LoadSource;
  intensity?: number;
}

const DT_CAP_S = 30;
const STOP_SPEED_MPS = 0.3;
const NP_WINDOW_S = 30;
const GRADE_WINDOW_M = 20;
const GRADE_CLAMP = 0.3;
const TRIMP_EXP_MALE = 1.92;
const TRIMP_EXP_FEMALE = 1.67;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Minetti (2002) metabolic cost of running vs gradient, normalised to flat
 * cost. `gradeFactor(0)` is exactly 1, so flat routes give GAP === raw speed.
 */
export function gradeFactor(grade: number): number {
  const g = clamp(grade, -GRADE_CLAMP, GRADE_CLAMP);
  const cost = ((((155.4 * g - 30.4) * g - 43.3) * g + 46.3) * g + 19.5) * g + 3.6;
  return cost / 3.6;
}

interface Sample {
  i: number;
  dtSec: number;
}

function isMoving(streams: LoadStreams, i: number): boolean {
  const mv = streams.moving;
  if (mv && mv[i] != null) return mv[i] === true;
  const v = streams.velocity?.[i];
  if (v == null) return true;
  return v >= STOP_SPEED_MPS;
}

/**
 * Every per-sample interval: dt from the time stream, capped at 30 s so a
 * recording gap contributes at most one capped step.
 */
function allSamples(streams: LoadStreams): Sample[] {
  const t = streams.time;
  const out: Sample[] = [];
  for (let i = 1; i < t.length; i++) {
    let dt = t[i] - t[i - 1];
    if (!(dt > 0)) continue;
    if (dt > DT_CAP_S) dt = DT_CAP_S;
    out.push({ i, dtSec: dt });
  }
  return out;
}

/** `allSamples` minus stopped samples. */
function movingSamples(streams: LoadStreams): Sample[] {
  return allSamples(streams).filter(({ i }) => isMoving(streams, i));
}

function movingSeconds(streams: LoadStreams): number {
  let s = 0;
  for (const { dtSec } of movingSamples(streams)) s += dtSec;
  return s;
}

/**
 * Per-sample grade from altitude/distance with a centered ~20 m rolling window
 * so GPS altitude noise doesn't spike the factor. Returns null when either
 * stream is absent (caller then falls back to raw speed).
 */
function computeGrades(streams: LoadStreams): number[] | null {
  const alt = streams.altitude;
  const dist = streams.distance;
  if (!alt || !dist) return null;
  const n = Math.min(alt.length, dist.length);
  const grades = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = alt[i];
    const d = dist[i];
    if (a == null || d == null) continue;
    let lo = i;
    let hi = i;
    while ((dist[hi] as number) - (dist[lo] as number) < GRADE_WINDOW_M) {
      const canLo = lo > 0 && alt[lo - 1] != null && dist[lo - 1] != null;
      const canHi = hi < n - 1 && alt[hi + 1] != null && dist[hi + 1] != null;
      if (!canLo && !canHi) break;
      const loGap = canLo ? d - (dist[lo - 1] as number) : Number.POSITIVE_INFINITY;
      const hiGap = canHi ? (dist[hi + 1] as number) - d : Number.POSITIVE_INFINITY;
      if (loGap <= hiGap) lo--;
      else hi++;
    }
    const dd = (dist[hi] as number) - (dist[lo] as number);
    const g = dd > 0 ? ((alt[hi] as number) - (alt[lo] as number)) / dd : 0;
    grades[i] = clamp(g, -GRADE_CLAMP, GRADE_CLAMP);
  }
  return grades;
}

/**
 * David Tinker's intervals.icu running-pace load, per-sample:
 * load = Σ dt·v_gap·(v_gap/threshold)·100/(threshold·3600). Constant flat pace
 * reduces to (v/threshold)²·moving_hours·100. `useGrade` toggles GAP (needs
 * altitude); raw speed otherwise.
 */
export function paceLoad(streams: LoadStreams, thresholdPaceMps: number, useGrade = true): number {
  if (!(thresholdPaceMps > 0)) return 0;
  const grades = useGrade ? computeGrades(streams) : null;
  let load = 0;
  for (const { i, dtSec } of movingSamples(streams)) {
    const v = streams.velocity?.[i];
    if (v == null || v <= 0) continue;
    const factor = grades ? gradeFactor(grades[i] ?? 0) : 1;
    const vGap = v * factor;
    load += (dtSec * vGap * (vGap / thresholdPaceMps) * 100) / (thresholdPaceMps * 3600);
  }
  return load;
}

/**
 * Exponential-TRIMP HRSS. HRr = (HR−rest)/(max−rest); TRIMP per sample =
 * dt_min·HRr·0.64·e^(F·HRr), F = 1.92 male / 1.67 female (male default).
 * HRSS = 100·TRIMP / TRIMP_1h@LTHR, denominator the closed form
 * 60·HRr_lthr·0.64·e^(F·HRr_lthr).
 *
 * Integrates every sample with a heart rate, stopped ones included: HR stays
 * elevated between padel points or resting on a climb, and that is real load.
 * The denominator is a threshold-derived per-hour constant that does not shrink
 * with dropped samples, so gating on movement here only ever under-counts —
 * stop-start sports came out up to 95% low against intervals.icu.
 */
export function hrss(streams: LoadStreams, params: HrssParams): number {
  const { lthr, restingHr, maxHr } = params;
  if (lthr == null || restingHr == null || maxHr == null) return 0;
  if (maxHr <= restingHr) return 0;
  const f = params.sex === "female" ? TRIMP_EXP_FEMALE : TRIMP_EXP_MALE;
  const hrrLthr = (lthr - restingHr) / (maxHr - restingHr);
  const denom = 60 * hrrLthr * 0.64 * Math.exp(f * hrrLthr);
  if (!(denom > 0)) return 0;

  let trimp = 0;
  for (const { i, dtSec } of allSamples(streams)) {
    const hr = streams.heartrate?.[i];
    if (hr == null) continue;
    const hrr = (hr - restingHr) / (maxHr - restingHr);
    if (hrr <= 0) continue;
    trimp += (dtSec / 60) * hrr * 0.64 * Math.exp(f * hrr);
  }
  return (100 * trimp) / denom;
}

/**
 * Coggan normalized power: 4th-root of the moving-time mean of a trailing 30 s
 * rolling average raised to the 4th. Null when no usable power stream.
 */
function normalizedPower(streams: LoadStreams): number | null {
  const w = streams.watts;
  const t = streams.time;
  if (!w) return null;
  const n = Math.min(w.length, t.length);
  const rolling = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (w[i] == null) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = i; j >= 0; j--) {
      if (t[i] - t[j] > NP_WINDOW_S) break;
      const p = w[j];
      if (p == null) continue;
      sum += p;
      cnt++;
    }
    if (cnt > 0) rolling[i] = sum / cnt;
  }

  let num = 0;
  let tot = 0;
  for (const { i, dtSec } of movingSamples(streams)) {
    const p = rolling[i];
    if (p == null) continue;
    num += dtSec * p ** 4;
    tot += dtSec;
  }
  if (tot === 0) return null;
  return (num / tot) ** 0.25;
}

/** Coggan TSS: IF = NP/FTP, TSS = IF²·moving_hours·100. */
export function powerTss(streams: LoadStreams, ftp: number): number {
  if (!(ftp > 0)) return 0;
  const np = normalizedPower(streams);
  if (np == null) return 0;
  const movingHours = movingSeconds(streams) / 3600;
  const intensity = np / ftp;
  return intensity * intensity * movingHours * 100;
}

function isRunning(sportType: string): boolean {
  return (RUNNING_SPORT_TYPES as readonly string[]).includes(sportType);
}

function hasSamples(stream: (number | null)[] | null | undefined): boolean {
  return !!stream && stream.some((v) => v != null);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Source-priority picker per sport: power → pace (running) → HRSS → null.
 * Load rounded to 1 decimal. GAP is used for pace only when altitude exists.
 */
export function computeActivityLoad(input: ComputeActivityLoadInput): ActivityLoadResult | null {
  const { sportType, streams, thresholds } = input;

  if (hasSamples(streams.watts) && thresholds.ftp != null) {
    const np = normalizedPower(streams);
    const load = powerTss(streams, thresholds.ftp);
    if (load > 0) {
      return {
        load: round1(load),
        source: "power",
        intensity: np != null ? np / thresholds.ftp : undefined,
      };
    }
  }

  if (isRunning(sportType) && hasSamples(streams.velocity) && thresholds.thresholdPaceMps != null) {
    const useGrade = hasSamples(streams.altitude);
    const load = paceLoad(streams, thresholds.thresholdPaceMps, useGrade);
    if (load > 0) return { load: round1(load), source: "pace" };
  }

  if (
    hasSamples(streams.heartrate) &&
    thresholds.lthr != null &&
    thresholds.restingHr != null &&
    thresholds.maxHr != null
  ) {
    const load = hrss(streams, {
      lthr: thresholds.lthr,
      restingHr: thresholds.restingHr,
      maxHr: thresholds.maxHr,
      sex: thresholds.sex,
    });
    if (load > 0) return { load: round1(load), source: "hr" };
  }

  return null;
}
