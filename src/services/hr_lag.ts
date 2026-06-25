/**
 * Heart-rate lag compensation. HR trails effort by ~10-30 s (cardiac response +
 * device smoothing), so an HR-based work/rest gate lands late and HR-detected
 * bouts drift right. intervals.icu flags this as an unfixed weakness and it is the
 * root cause of our HR-ambiguous reps (626). We cross-correlate HR against the
 * speed signal, find the lag that best aligns them, and shift HR earlier by it
 * before HR is used in any segmentation decision. See the brain entry
 * `interval-segmentation-approaches-landscape`.
 */
import { SEGMENTER_CONFIG } from "./segmenter_config";

/** Pearson correlation of two equal-length series; 0 when undefined. */
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Estimate the lag (seconds, ≥0) by which HR trails speed: the shift that
 * maximises correlation between speed[i] and hr[i+lag]. Returns 0 when no shift
 * beats the zero-lag correlation by `minCorrelationGain` (e.g. steady runs with no
 * structure to align). Operates on the sampled series; `time` gives the seconds
 * axis so non-1 Hz streams are handled by converting the second-lag to an index
 * span via the median sample period.
 */
export function estimateHrLag(
  time: number[],
  speed: number[],
  hr: number[],
  maxSeconds = SEGMENTER_CONFIG.hrLag.maxSeconds,
  minGain = SEGMENTER_CONFIG.hrLag.minCorrelationGain,
): number {
  const n = Math.min(time.length, speed.length, hr.length);
  if (n < 4) return 0;
  const dt = (time[n - 1] - time[0]) / (n - 1);
  if (dt <= 0) return 0;
  const maxShift = Math.max(1, Math.round(maxSeconds / dt));

  const base = correlation(speed.slice(0, n), hr.slice(0, n));
  let bestCorr = base;
  let bestShift = 0;
  for (let shift = 1; shift <= maxShift && shift < n - 2; shift++) {
    const s = speed.slice(0, n - shift);
    const h = hr.slice(shift, n);
    const c = correlation(s, h);
    if (c > bestCorr + minGain) {
      bestCorr = c;
      bestShift = shift;
    }
  }
  return bestShift * dt;
}

/**
 * Shift HR earlier in time by `lagSeconds` (pulling each sample's HR back to the
 * effort that caused it), holding the array length. The tail repeats the last
 * value. Returns the input unchanged when the lag rounds to zero.
 */
export function shiftHrEarlier(time: number[], hr: number[], lagSeconds: number): number[] {
  const n = hr.length;
  if (n === 0 || lagSeconds <= 0) return hr;
  const dt = n > 1 ? (time[n - 1] - time[0]) / (n - 1) : 1;
  if (dt <= 0) return hr;
  const shift = Math.round(lagSeconds / dt);
  if (shift <= 0) return hr;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = hr[Math.min(i + shift, n - 1)];
  return out;
}

/** Convenience: estimate and apply HR-lag in one call (no-op when disabled). */
export function compensateHrLag(time: number[], speed: number[], hr: number[]): number[] {
  if (!SEGMENTER_CONFIG.hrLag.enabled) return hr;
  const lag = estimateHrLag(time, speed, hr);
  return shiftHrEarlier(time, hr, lag);
}
