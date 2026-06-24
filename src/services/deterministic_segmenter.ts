import type { InsertIntervalSegment } from "../schema/interval_segments";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";
import { calculateSegmentStats } from "./utils";

/**
 * Deterministic interval segmentation for the `lapsMatch=False` path (indoor /
 * dense / one-big-work-lap), replacing the LLM tiling that invented rep counts
 * and crushed the warmup to 60s. Strategy validated on 8 real workouts — see the
 * brain entry `deterministic-interval-segmentation`.
 *
 * Signal facts: speed/pace is the primary rep discriminator (HR can't separate
 * dense intervals); always operate in time[] seconds (streams aren't always 1Hz);
 * lap-bound the work window before detecting reps so warmup strides don't fool it.
 */

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

interface RepDesc {
  workType: "DISTANCE" | "TIME";
  workValue: number;
  recoveryType: "DISTANCE" | "TIME";
  recoveryValue: number;
  targetPace: number | null;
  setGroupIndex: number;
  isLastInSet: boolean;
}

type LapMode = "per-rep" | "boundary" | "unusable";
export type SegmentMode = LapMode | "inferred";

interface WorkBout {
  start: number;
  end: number;
}

export interface DeterministicResult {
  segments: InsertIntervalSegment[];
  confidence: number;
  mode: SegmentMode;
}

const MIN_LAP_SECONDS = 10;
const SNAP_WINDOW_SECONDS = 45;
const MIN_BOUT_SECONDS = 10;
const MIN_GAP_SECONDS = 4;

export function flattenReps(userSets: ExpandedIntervalSet[]): RepDesc[] {
  const reps: RepDesc[] = [];
  userSets.forEach((set, setIdx) => {
    set.steps.forEach((step, stepIdx) => {
      reps.push({
        workType: step.work_type === "DISTANCE" ? "DISTANCE" : "TIME",
        workValue: step.work_value,
        recoveryType: step.recovery_type === "DISTANCE" ? "DISTANCE" : "TIME",
        recoveryValue: step.recovery_value ?? 0,
        targetPace: step.target_pace ?? null,
        setGroupIndex: setIdx + 1,
        isLastInSet: stepIdx === set.steps.length - 1,
      });
    });
  });
  return reps;
}

/** Windowed speed (m/s) from cumulative distance; mirrors the app's deriveVelocity. */
export function deriveSpeed(time: number[], distance: number[], windowSec = 10): number[] {
  const n = time.length;
  const v = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let lo = i;
    while (lo > 0 && time[i] - time[lo] < windowSec) lo--;
    const dt = time[i] - time[lo];
    const dd = (distance[i] ?? 0) - (distance[lo] ?? 0);
    if (dt > 0 && dd >= 0) v[i] = dd / dt;
    else if (i > 0) v[i] = v[i - 1];
  }
  return v;
}

function isJunkLap(l: Lap): boolean {
  const dur = l.elapsed_time ?? 0;
  const dist = l.distance ?? 0;
  const spd = l.average_speed ?? 0;
  return dur < MIN_LAP_SECONDS || (dist < 5 && spd < 0.5);
}

function lapWindow(l: Lap, time: number[]): WorkBout {
  const si = Math.min(l.start_index ?? 0, time.length - 1);
  const start = time[si] ?? 0;
  return { start, end: start + (l.elapsed_time ?? 0) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Mode-aware lap classification:
 * - ≤1 meaningful lap → unusable (derive window from speed).
 * - ≤5 meaningful laps → boundary (HR separates warmup/work/cooldown here).
 * - many laps → per-rep (work laps are the high-SPEED ones; rest/warmup are slow).
 */
export function classifyLaps(
  laps: Lap[],
  time: number[],
): { mode: LapMode; ws: number; we: number; workLaps: Lap[] } {
  const meaningful = laps.filter((l) => !isJunkLap(l));
  const t0 = time[0] ?? 0;
  const tEnd = time[time.length - 1] ?? 0;

  if (meaningful.length <= 1) return { mode: "unusable", ws: t0, we: tEnd, workLaps: [] };

  if (meaningful.length <= 5) {
    const hrs = meaningful.map((l) => l.average_heartrate ?? 0);
    const mx = Math.max(...hrs);
    const mn = Math.min(...hrs);
    const thr = mn + 0.6 * (mx - mn);
    const idx = hrs.map((h, i) => (h >= thr ? i : -1)).filter((i) => i >= 0);
    const a = idx[0] ?? 0;
    const b = idx[idx.length - 1] ?? meaningful.length - 1;
    return {
      mode: "boundary",
      ws: lapWindow(meaningful[a], time).start,
      we: lapWindow(meaningful[b], time).end,
      workLaps: meaningful.slice(a, b + 1),
    };
  }

  const speeds = meaningful.map((l) => l.average_speed ?? 0);
  const thr = 0.75 * Math.max(...speeds);
  const work = meaningful.filter((_, i) => speeds[i] >= thr);
  return {
    mode: "per-rep",
    ws: lapWindow(work[0], time).start,
    we: lapWindow(work[work.length - 1], time).end,
    workLaps: work,
  };
}

/**
 * Surge detection: find sustained high-speed runs inside [ws, we]. This is the
 * primary rep primitive for the unusable / no-structure cases — the work region
 * is [firstBout.start, lastBout.end], which excludes a slow warmup/cooldown and
 * fixes the warmup-lands-early bug (the previous sliding-window detector leaked
 * ~200 s of warmup into the work window). Threshold is the midpoint between the
 * work and rest speed levels; adjacent runs separated by a sub-gap are merged and
 * too-short runs dropped so a single warmup stride doesn't read as a rep.
 */
export function detectBouts(
  time: number[],
  speed: number[],
  ws: number,
  we: number,
  minBoutSec = MIN_BOUT_SECONDS,
  minGapSec = MIN_GAP_SECONDS,
): { bouts: WorkBout[]; workLvl: number; restLvl: number } {
  const inWin = (i: number): boolean => time[i] >= ws && time[i] <= we;
  // Keep rest (near-zero) samples in the distribution — they ARE the low level.
  // Threshold off a low floor, not a midpoint percentile: when work dominates the
  // time (e.g. 360s work / 60s rest ≈ 85% duty) even the 15th percentile lands in
  // the work band, so a percentile-midpoint never separates. Floor (p05) ≈ rest,
  // workLvl (p75) ≈ work; the gate sits halfway between.
  const win = speed.filter((_, i) => inWin(i)).sort((a, b) => a - b);
  if (win.length === 0) return { bouts: [], workLvl: 0, restLvl: 0 };
  const workLvl = percentile(win, 0.75);
  const restLvl = percentile(win, 0.05);
  const thr = restLvl + 0.5 * (workLvl - restLvl);
  if (workLvl <= 0 || thr <= 0) return { bouts: [], workLvl, restLvl };

  const raw: WorkBout[] = [];
  let startIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < time.length; i++) {
    if (!inWin(i)) continue;
    lastIdx = i;
    const hi = speed[i] > thr;
    if (hi && startIdx < 0) startIdx = i;
    if (!hi && startIdx >= 0) {
      raw.push({ start: time[startIdx], end: time[i - 1] ?? time[startIdx] });
      startIdx = -1;
    }
  }
  if (startIdx >= 0 && lastIdx >= 0) raw.push({ start: time[startIdx], end: time[lastIdx] });

  const merged: WorkBout[] = [];
  for (const b of raw) {
    const prev = merged[merged.length - 1];
    if (prev && b.start - prev.end < minGapSec) prev.end = b.end;
    else merged.push({ ...b });
  }
  const bouts = merged.filter((b) => b.end - b.start >= minBoutSec);
  return { bouts, workLvl, restLvl };
}

/**
 * Pick the contiguous run of `n` bouts with the most uniform spacing. When surge
 * detection turns up more bouts than reps (a warmup/cooldown stride read as a
 * bout), the real reps are the evenly-spaced cluster; the stray stride sits off
 * to one side behind an outlier gap, so the lowest-variance window drops it.
 */
function selectRegion(bouts: WorkBout[], n: number): WorkBout[] {
  if (n <= 0 || bouts.length <= n) return bouts;
  let best = bouts.slice(0, n);
  let bestScore = Number.POSITIVE_INFINITY;
  for (let s = 0; s + n <= bouts.length; s++) {
    const slice = bouts.slice(s, s + n);
    const gaps: number[] = [];
    for (let k = 1; k < slice.length; k++) gaps.push(slice[k].start - slice[k - 1].end);
    const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / Math.max(1, gaps.length);
    if (variance < bestScore) {
      bestScore = variance;
      best = slice;
    }
  }
  return best;
}

/** Synthesize reps from detected bouts when the user gave no structure (item 1). */
function inferRepsFromBouts(bouts: WorkBout[]): RepDesc[] {
  const workMed = median(bouts.map((b) => b.end - b.start));
  const gaps: number[] = [];
  for (let i = 1; i < bouts.length; i++) gaps.push(bouts[i].start - bouts[i - 1].end);
  const restMed = median(gaps);
  return bouts.map((_, i) => ({
    workType: "TIME",
    workValue: Math.round(workMed),
    recoveryType: "TIME",
    recoveryValue: Math.round(restMed),
    targetPace: null,
    setGroupIndex: 1,
    isLastInSet: i === bouts.length - 1,
  }));
}

/** Slide a window of ~structSecs over the speed series, maximizing in-work fraction. */
export function detectWorkWindowBySpeed(
  time: number[],
  speed: number[],
  structSecs: number,
): { ws: number; we: number } {
  const n = time.length;
  const t0 = time[0] ?? 0;
  const tEnd = time[n - 1] ?? 0;
  const positive = speed.filter((x) => x > 0).sort((a, b) => a - b);
  if (positive.length === 0) return { ws: t0, we: tEnd };
  const thr = percentile(positive, 0.75) * 0.5;
  const working = speed.map((x) => (x > thr ? 1 : 0));
  let best = { frac: -1, ws: t0, we: tEnd };
  for (let i = 0; i < n; i++) {
    const endT = time[i] + structSecs;
    let j = i;
    while (j < n && time[j] < endT) j++;
    const jj = Math.min(j, n - 1);
    if (jj <= i || time[jj] - time[i] < 0.9 * structSecs) continue;
    let sum = 0;
    for (let k = i; k < jj; k++) sum += working[k];
    const frac = sum / (jj - i);
    if (frac > best.frac) best = { frac, ws: time[i], we: time[jj] };
  }
  return { ws: best.ws, we: best.we };
}

/** Nearest time index for a target time (binary-ish linear scan is fine at this size). */
function indexAtTime(time: number[], target: number): number {
  let idx = time.findIndex((t) => t >= target);
  if (idx === -1) idx = time.length - 1;
  return idx;
}

/**
 * Lay the nominal work/rest durations from `ws`, then snap each work-bout edge to
 * the nearest speed transition (improves alignment, esp. the unusable/no-lap case).
 * Guarantees exactly `reps.length` work bouts. `snapped`/`total` report how many
 * edges locked onto a real transition — the caller folds that into confidence.
 */
export function templatePlace(
  ws: number,
  we: number,
  reps: RepDesc[],
  time: number[],
  speed: number[],
): { bouts: WorkBout[]; snapped: number; total: number } {
  const win = speed.filter((_, i) => time[i] >= ws && time[i] <= we && speed[i] > 0).sort((a, b) => a - b);
  const workLvl = percentile(win, 0.6);
  const restLvl = percentile(win, 0.15);
  const thr = (workLvl + restLvl) / 2;

  const workSecOf = (r: RepDesc): number =>
    r.workType === "TIME" ? r.workValue : workLvl > 0 ? r.workValue / workLvl : 60;
  const restSecOf = (r: RepDesc): number =>
    r.recoveryType === "TIME" ? r.recoveryValue : restLvl > 0.3 ? r.recoveryValue / restLvl : r.recoveryValue;

  const snap = (target: number, rising: boolean): { t: number; hit: boolean } => {
    let bestT = target;
    let bestD = SNAP_WINDOW_SECONDS + 1;
    const lo = indexAtTime(time, target - SNAP_WINDOW_SECONDS);
    const hi = indexAtTime(time, target + SNAP_WINDOW_SECONDS);
    for (let k = Math.max(1, lo); k <= hi && k < speed.length; k++) {
      const crossed = rising
        ? speed[k - 1] <= thr && speed[k] > thr
        : speed[k - 1] > thr && speed[k] <= thr;
      if (crossed) {
        const d = Math.abs(time[k] - target);
        if (d < bestD) {
          bestD = d;
          bestT = time[k];
        }
      }
    }
    return { t: bestT, hit: bestD <= SNAP_WINDOW_SECONDS };
  };

  const bouts: WorkBout[] = [];
  let snapped = 0;
  let cur = ws;
  for (let i = 0; i < reps.length; i++) {
    const s = snap(cur, true);
    const nominalEnd = s.t + workSecOf(reps[i]);
    const e = snap(nominalEnd, false);
    if (s.hit) snapped++;
    if (e.hit) snapped++;
    const end = Math.min(e.t, we);
    bouts.push({ start: s.t, end: Math.max(end, s.t + 1) });
    cur = end + restSecOf(reps[i]);
    if (cur >= we) cur = we;
  }
  return { bouts, snapped, total: reps.length * 2 };
}

function estimateStructSecs(reps: RepDesc[], time: number[], speed: number[]): number {
  const positive = speed.filter((x) => x > 0).sort((a, b) => a - b);
  const workLvl = percentile(positive, 0.75);
  const restLvl = percentile(positive, 0.2);
  let total = 0;
  for (const r of reps) {
    total += r.workType === "TIME" ? r.workValue : workLvl > 0 ? r.workValue / workLvl : 60;
    total += r.recoveryType === "TIME" ? r.recoveryValue : restLvl > 0.3 ? r.recoveryValue / restLvl : 0;
  }
  return total;
}

/** Mean in-bout speed vs mean inter-bout speed → [0,1] contrast (higher = cleaner reps). */
function speedContrast(time: number[], speed: number[], bouts: WorkBout[]): number {
  if (bouts.length === 0) return 0;
  const inBout = (t: number): boolean => bouts.some((b) => t >= b.start && t <= b.end);
  const work: number[] = [];
  const rest: number[] = [];
  const lo = bouts[0].start;
  const hi = bouts[bouts.length - 1].end;
  for (let i = 0; i < time.length; i++) {
    if (time[i] < lo || time[i] > hi) continue;
    (inBout(time[i]) ? work : rest).push(speed[i]);
  }
  if (work.length === 0) return 0;
  const wm = work.reduce((a, b) => a + b, 0) / work.length;
  const rm = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
  if (wm <= 0) return 0;
  return Math.max(0, Math.min(1, (wm - rm) / wm));
}

function pushSeg(
  out: InsertIntervalSegment[],
  activityId: number,
  streams: StatsStreams,
  type: InsertIntervalSegment["type"],
  setGroupIndex: number,
  targetType: InsertIntervalSegment["targetType"],
  targetValue: number,
  targetPace: number | null,
  start: number,
  end: number,
): void {
  const stats = calculateSegmentStats(streams, start, end);
  if (!stats) return;
  out.push({
    activityId,
    segmentIndex: out.length,
    setGroupIndex,
    type,
    targetType,
    targetValue,
    targetPace,
    timeSeriesEndTime: stats.timeSeriesEndTime,
    actualDistance: stats.actualDistance,
    actualDuration: stats.actualDuration,
    avgHeartRate: stats.avgHeartRate,
  });
}

/**
 * Build segments deterministically. Returns null when it can't (no usable
 * streams, no reps and nothing inferable). Otherwise returns the segments plus a
 * [0,1] confidence so the caller can fall back to the LLM on a weak result.
 *
 * Confidence blends: how many template edges snapped to a real speed transition
 * (1.0 when bouts come straight from laps/surges), the work-vs-rest speed
 * contrast, and whether the bout count matched the expected rep count. Inferred
 * structures (no user title) are discounted since the rep count is itself a guess.
 */
/** Short TIME reps (≤ this many seconds) read short because the pace stream lags the effort. */
export const SHORT_REP_EXPAND_MAX_SECONDS = 90;

/**
 * Recover the prescribed duration of short TIME reps whose detected bout is only
 * the late, brief high-speed CORE (pace lag). Expand SYMMETRICALLY around the core
 * centre — the lag shifts the core LATE, so forward-only expansion overshoots into
 * the rest and inverts work/rest. Never shrinks below the core; clamps to the
 * neighbouring bouts (and t0/tEnd). Pure; only touches TIME reps ≤ `maxSec`.
 */
export function expandShortReps(
  bouts: WorkBout[],
  reps: RepDesc[],
  t0: number,
  tEnd: number,
  maxSec: number = SHORT_REP_EXPAND_MAX_SECONDS,
): WorkBout[] {
  const out = bouts.map((b) => ({ ...b }));
  for (let i = 0; i < out.length && i < reps.length; i++) {
    const rep = reps[i];
    if (rep.workType !== "TIME" || rep.workValue > maxSec) continue;
    const core = out[i];
    if (core.end - core.start >= rep.workValue) continue;
    const center = (core.start + core.end) / 2;
    const half = rep.workValue / 2;
    const prevEnd = i > 0 ? out[i - 1].end : t0;
    const nextStart = i + 1 < out.length ? out[i + 1].start : tEnd;
    out[i] = {
      start: Math.max(Math.min(center - half, core.start), prevEnd),
      end: Math.min(Math.max(center + half, core.end), nextStart, tEnd),
    };
  }
  return out;
}

/**
 * Bind a prescribed rep sequence to detected work bouts by MEASURE, not position.
 * On noisy treadmill data the speed gate lets a few rests cross into the work-lap
 * set, so there are more bouts than reps; assigning reps[i]→bouts[i] then shifts
 * every rep after a spurious bout — a 175s effort ends up tagged the "60s" rep
 * (activity 622, sets 2-4). Picks the order-preserving subsequence of `bouts` of
 * length reps.length that minimises total relative measure error (DP, i.e.
 * DTW-with-skips). Sequence order makes a spurious bout expensive to keep — it
 * would have to match the NEXT prescribed value, which it doesn't — so the extras
 * get skipped and the surrounding REST segments absorb their time. Measure is
 * duration for TIME reps, covered distance for DISTANCE reps. Caller only invokes
 * this when bouts.length > reps.length; equal/short counts keep positional.
 */
export function alignBoutsToReps(
  bouts: WorkBout[],
  reps: RepDesc[],
  time: number[],
  distance: number[],
): WorkBout[] {
  const N = reps.length;
  const M = bouts.length;
  if (N === 0) return [];
  if (M <= N) return bouts.slice(0, N);

  const measure = (b: WorkBout, r: RepDesc): number => {
    if (r.workType === "TIME") return b.end - b.start;
    const si = indexAtTime(time, b.start);
    const ei = indexAtTime(time, b.end);
    return Math.max(0, (distance[ei] ?? 0) - (distance[si] ?? 0));
  };
  const cost = (repIdx: number, boutIdx: number): number => {
    const tgt = reps[repIdx].workValue;
    if (tgt <= 0) return 0;
    return Math.abs(measure(bouts[boutIdx], reps[repIdx]) - tgt) / tgt;
  };

  const INF = Number.POSITIVE_INFINITY;
  // dp[i][j] = min total cost to bind the first i reps using the first j bouts.
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(M + 1).fill(INF));
  const took: boolean[][] = Array.from({ length: N + 1 }, () => new Array<boolean>(M + 1).fill(false));
  for (let j = 0; j <= M; j++) dp[0][j] = 0;
  for (let i = 1; i <= N; i++) {
    for (let j = i; j <= M; j++) {
      const skip = dp[i][j - 1];
      const match = dp[i - 1][j - 1] + cost(i - 1, j - 1);
      if (match < skip) {
        dp[i][j] = match;
        took[i][j] = true;
      } else {
        dp[i][j] = skip;
      }
    }
  }
  const chosen: WorkBout[] = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    if (took[i][j]) {
      chosen.push(bouts[j - 1]);
      i--;
      j--;
    } else {
      j--;
    }
  }
  return chosen.reverse();
}

/** Default over-run tolerance: keep real variation, trim only clear overruns. */
export const OVERLONG_TOLERANCE = 0.15;

/**
 * Trim work bouts that overrun the prescribed measure — the prescribed value is a
 * strong prior (a "1000 m" rep is ~950-1050 m, not 1200; a long TIME rep drifts
 * only ±10-20 s). Detection or device laps sometimes overrun: a lap that kept
 * counting, or a boundary that leaked into the rest. When a bout's measure exceeds
 * the target by more than `tol`, pull its END back to exactly the prescribed
 * measure from the bout start; the trimmed tail falls into the following REST.
 * Within tolerance the detected end is kept (real variation). Never EXTENDS — under
 * -measure is expandShortReps' job — and only touches known TIME/DISTANCE reps.
 */
export function clampOverlongBouts(
  bouts: WorkBout[],
  reps: RepDesc[],
  time: number[],
  distance: number[],
  tol: number = OVERLONG_TOLERANCE,
): WorkBout[] {
  const out = bouts.map((b) => ({ ...b }));
  for (let i = 0; i < out.length && i < reps.length; i++) {
    const rep = reps[i];
    const b = out[i];
    const target = rep.workValue;
    if (target <= 0) continue;
    if (rep.workType === "TIME") {
      if (b.end - b.start > target * (1 + tol)) {
        b.end = Math.max(b.start + target, b.start + 1);
      }
    } else {
      const si = indexAtTime(time, b.start);
      const ei = indexAtTime(time, b.end);
      const measured = Math.max(0, (distance[ei] ?? 0) - (distance[si] ?? 0));
      if (measured > target * (1 + tol)) {
        const targetDist = (distance[si] ?? 0) + target;
        let k = si;
        while (k < ei && (distance[k] ?? 0) < targetDist) k++;
        b.end = Math.max(time[k] ?? b.end, b.start + 1);
      }
    }
  }
  return out;
}

export function buildSegmentsDeterministic(
  activityId: number,
  laps: Lap[],
  userSets: ExpandedIntervalSet[],
  streams: StatsStreams,
): DeterministicResult | null {
  const time = streams.time.data;
  const distance = streams.distance.data;
  if (time.length < 3 || distance.length !== time.length) return null;

  const speed = deriveSpeed(time, distance);
  const t0 = time[0];
  const tEnd = time[time.length - 1];

  let reps = flattenReps(userSets);
  const inferred = reps.length === 0;

  const cls = classifyLaps(laps, time);
  let mode: SegmentMode = inferred ? "inferred" : cls.mode;

  let bouts: WorkBout[];
  let snapFrac = 1;
  let countMatch = 1;
  // Set when we deliberately lay the full known structure because detection found
  // fewer work blocks than reps — the title count is authoritative, so the result
  // must be USED rather than discarded for the (count-inventing) LLM fallback.
  let forcedCount = false;

  if (inferred) {
    const region = cls.mode === "unusable" ? { ws: t0, we: tEnd } : { ws: cls.ws, we: cls.we };
    const { bouts: detected } = detectBouts(time, speed, region.ws, region.we);
    if (detected.length === 0) return null;
    bouts = detected;
    reps = inferRepsFromBouts(detected);
  } else if (cls.mode === "per-rep" && cls.workLaps.length > 0) {
    const lapBouts = cls.workLaps.map((l) => lapWindow(l, time));
    if (lapBouts.length > reps.length) {
      // More work-candidates than prescribed reps — noisy treadmill laps where a
      // few rests crossed the speed gate. Bind each rep to its best-matching bout
      // by measure instead of by position, so a spurious lap no longer shifts
      // every rep after it (activity 622). See alignBoutsToReps.
      bouts = alignBoutsToReps(lapBouts, reps, time, distance);
      countMatch = bouts.length === reps.length ? 1 : 0.5;
    } else if (lapBouts.length < reps.length) {
      // UNDER-DETECTION: lapping found fewer work blocks than the known structure
      // — HR-only / speed-ambiguous reps (626) or a coarse compound the laps don't
      // separate (616). The TITLE count is authoritative: lay the prescribed reps
      // by template across the work window so the segment count matches the
      // structure rather than shipping a truncated breakdown. See countGuard note.
      const window = detectWorkWindowBySpeed(time, speed, estimateStructSecs(reps, time, speed));
      const placed = templatePlace(window.ws, window.we, reps, time, speed);
      bouts = placed.bouts;
      snapFrac = placed.total > 0 ? placed.snapped / placed.total : 0;
      countMatch = 1;
      forcedCount = true;
    } else {
      bouts = lapBouts;
      countMatch = 1;
    }
  } else {
    const region = cls.mode === "boundary" ? { ws: cls.ws, we: cls.we } : { ws: t0, we: tEnd };
    const { bouts: detected } = detectBouts(time, speed, region.ws, region.we);
    const picked = selectRegion(detected, reps.length);
    if (picked.length === reps.length) {
      bouts = picked;
    } else {
      const window =
        cls.mode === "boundary"
          ? region
          : detectWorkWindowBySpeed(time, speed, estimateStructSecs(reps, time, speed));
      const placed = templatePlace(window.ws, window.we, reps, time, speed);
      bouts = placed.bouts;
      snapFrac = placed.total > 0 ? placed.snapped / placed.total : 0;
      countMatch = 0.6;
    }
  }
  if (bouts.length === 0) return null;

  // Recover short TIME reps under-measured due to pace lag — only when the
  // structure is KNOWN and bouts came from stream detection (not authoritative
  // device laps / inference). See expandShortReps.
  if (!inferred && mode !== "per-rep") {
    bouts = expandShortReps(bouts, reps, t0, tEnd);
  }

  // Pull in work bouts that overrun the prescribed measure (a "1000 m" rep that
  // a device lap recorded as 1200 m). Applies in every known-structure mode,
  // including per-rep, since the overrun usually comes from the laps themselves.
  if (!inferred) {
    bouts = clampOverlongBouts(bouts, reps, time, distance);
  }

  const count = Math.min(bouts.length, reps.length);
  const out: InsertIntervalSegment[] = [];

  if (bouts[0].start > t0 + 1) {
    pushSeg(out, activityId, streams, "WARMUP", 0, "custom", 0, null, t0, bouts[0].start);
  }
  for (let i = 0; i < count; i++) {
    const rep = reps[i];
    const bout = bouts[i];
    pushSeg(
      out,
      activityId,
      streams,
      "INTERVALS",
      rep.setGroupIndex,
      rep.workType === "DISTANCE" ? "distance" : "time",
      rep.workValue,
      rep.targetPace,
      bout.start,
      bout.end,
    );
    const nextStart = i + 1 < count ? bouts[i + 1].start : tEnd;
    if (nextStart > bout.end + 1 && i + 1 < count) {
      pushSeg(
        out,
        activityId,
        streams,
        rep.isLastInSet ? "ACTIVE_REST" : "REST",
        rep.setGroupIndex,
        rep.recoveryType === "DISTANCE" ? "distance" : "time",
        rep.recoveryValue,
        null,
        bout.end,
        nextStart,
      );
    }
  }
  const lastEnd = bouts[count - 1].end;
  if (tEnd > lastEnd + 1) {
    pushSeg(out, activityId, streams, "COOL_DOWN", 0, "custom", 0, null, lastEnd, tEnd);
  }
  if (out.length === 0) return null;

  const contrast = speedContrast(time, speed, bouts.slice(0, count));
  let confidence = 0.45 * snapFrac + 0.3 * contrast + 0.25 * countMatch;
  if (inferred) confidence *= 0.85;
  // Count-guaranteed structures are user-authoritative on count; their template
  // placement snaps few edges (the missing reps have no transitions) so the raw
  // blend reads low — floor above the cascade's LLM-fallback threshold so the
  // structure-honoring split is kept instead of handing off to the count-inventing LLM.
  if (forcedCount) confidence = Math.max(confidence, 0.6);
  confidence = Math.max(0, Math.min(1, confidence));

  return { segments: out, confidence, mode };
}
