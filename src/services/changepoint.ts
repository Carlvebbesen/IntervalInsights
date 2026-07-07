/**
 * Change-point detection (PELT) and 2-state label smoothing (Viterbi) — the
 * principled core for splitting a 1-D effort signal (speed or HR) into work/rest
 * runs. Replaces raw threshold "surge" detection, which the literature flags as
 * the most over-segmentation-prone family; PELT gives an exact multi-changepoint
 * partition under an L2 (piecewise-constant Gaussian) cost, and the Viterbi pass
 * adds a Markov stickiness prior that suppresses single-sample flicker. See the
 * brain entry `interval-segmentation-approaches-landscape`.
 */
import { SEGMENTER_CONFIG } from "./segmenter_config";

/** Sample variance of a series (population form); 0 for <2 points. */
export function variance(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
}

/**
 * PELT (Pruned Exact Linear Time) change-point detection under an L2 cost.
 * Returns the interior change-point indices (segment boundaries, exclusive of 0
 * and n). `minSize` is the minimum segment length in samples — the short-rep
 * guard. `penalty` is the per-changepoint cost; higher → fewer segments. Pruning
 * keeps the expected runtime near-linear; worst case is O(n²).
 */
export function pelt(values: number[], minSize: number, penalty: number): number[] {
  const n = values.length;
  if (n < 2 * minSize) return [];

  // Prefix sums of x and x² → O(1) segment cost.
  const p1 = new Float64Array(n + 1);
  const p2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    p1[i + 1] = p1[i] + values[i];
    p2[i + 1] = p2[i] + values[i] * values[i];
  }
  // SSE of segment [s, t): Σx² − (Σx)²/len.
  const cost = (s: number, t: number): number => {
    const len = t - s;
    if (len <= 0) return 0;
    const sum = p1[t] - p1[s];
    return p2[t] - p2[s] - (sum * sum) / len;
  };

  const F = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  F[0] = -penalty;
  const prev = new Int32Array(n + 1).fill(0);
  let candidates: number[] = [0];

  for (let t = minSize; t <= n; t++) {
    let best = Number.POSITIVE_INFINITY;
    let bestS = 0;
    for (const s of candidates) {
      if (t - s < minSize) continue;
      const c = F[s] + cost(s, t) + penalty;
      if (c < best) {
        best = c;
        bestS = s;
      }
    }
    F[t] = best;
    prev[t] = bestS;
    // Prune: drop s that can never beat the current optimum (PELT inequality, K=0).
    const kept: number[] = [];
    for (const s of candidates) {
      if (F[s] + cost(s, t) <= F[t]) kept.push(s);
    }
    kept.push(t - minSize + 1 > 0 ? t - minSize + 1 : 0);
    candidates = kept;
  }

  const cps: number[] = [];
  let t = n;
  while (t > 0) {
    const s = prev[t];
    if (s > 0) cps.push(s);
    t = s;
  }
  return cps.reverse();
}

/** Median of a copy-sorted array; 0 when empty. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Robust noise-variance estimate from squared successive differences. Var(xᵢ−xᵢ₋₁)
 * = 2σ² for i.i.d. noise, and the MEDIAN of those squared diffs ignores the few
 * large jumps at real change-points — so this recovers the within-segment noise
 * floor, not the (much larger) total signal variance.
 */
export function noiseVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const sq: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    sq.push(d * d);
  }
  return medianOf(sq) / 2;
}

/**
 * Default PELT penalty for a mean-shift model: BIC-style β·σ²·log(n), with σ² the
 * ROBUST NOISE variance (not the total signal variance — that over-penalises
 * exactly the high-contrast many-rep signals and collapses 20×45/15 into 2
 * segments). Self-adjusts: noisy treadmill data raises σ² (fewer false reps),
 * clean track data lowers it (resolves short rests).
 */
export function defaultPenalty(
  values: number[],
  scale = SEGMENTER_CONFIG.pelt.penaltyScale,
): number {
  const sigma2 = noiseVariance(values);
  const n = Math.max(2, values.length);
  return scale * Math.max(sigma2, 1e-9) * Math.log(n);
}

/**
 * 2-state Viterbi smoothing over a continuous signal. States are "rest" (mean
 * `muRest`) and "work" (mean `muWork`); emission cost is squared deviation, and a
 * `switchPenalty` is charged on every state change. Returns a 0/1 label per
 * sample (1 = work) with the spurious flicker of a raw threshold removed — the
 * Markov prior academics use instead of cutpoint detection.
 */
export function viterbiTwoState(
  values: number[],
  muRest: number,
  muWork: number,
  switchPenalty: number,
): number[] {
  const n = values.length;
  if (n === 0) return [];
  const emit = (x: number, mu: number): number => (x - mu) ** 2;

  // cost[state], backpointer[i][state]
  let cRest = emit(values[0], muRest);
  let cWork = emit(values[0], muWork);
  const back: Uint8Array[] = [new Uint8Array(2)];
  for (let i = 1; i < n; i++) {
    const bp = new Uint8Array(2);
    // stay vs switch into each state
    const restStay = cRest;
    const restSwitch = cWork + switchPenalty;
    const nRest = (restStay <= restSwitch ? restStay : restSwitch) + emit(values[i], muRest);
    bp[0] = restStay <= restSwitch ? 0 : 1;

    const workStay = cWork;
    const workSwitch = cRest + switchPenalty;
    const nWork = (workStay <= workSwitch ? workStay : workSwitch) + emit(values[i], muWork);
    bp[1] = workStay <= workSwitch ? 1 : 0;

    cRest = nRest;
    cWork = nWork;
    back.push(bp);
  }

  const labels = new Array<number>(n).fill(0);
  let state = cWork < cRest ? 1 : 0;
  labels[n - 1] = state;
  for (let i = n - 1; i > 0; i--) {
    state = back[i][state];
    labels[i - 1] = state;
  }
  return labels;
}
