import type {
  HrvStatus,
  IFitnessPoint,
  IFitnessSeriesResult,
  IHrvBaseline,
} from "../types/intervals/IFitness";
import type { IIntervalsWellness } from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";
import { withIntervalsToken } from "./intervals_token_helper";
import { toISODate } from "./utils";

const DAY_MS = 86_400_000;

// hrvStatus is derived here — intervals.icu only gives raw nightly `hrv`. This
// mirrors how Garmin plots HRV Status: it classifies the *7-day rolling average*
// (not the raw nightly value) against a slow-moving personal baseline band.
//   - 7-day average inside the band  → balanced (green dot)
//   - 7-day average outside the band → unbalanced (orange dot), either direction
// Garmin's per-day dots are only ever balanced/unbalanced; "low"/"poor" are
// higher-level *headline* statuses (and "poor" needs the athlete's age), so the
// per-day series here never emits them.
//
// IMPORTANT: the baseline must be long & slow-moving. Garmin's band reflects
// months of history, so when HRV trends down the band lags above it and the
// dips correctly read as unbalanced. A short window would hug recent data and
// the average could never leave the band (→ everything green).
//
// We can't reproduce Garmin's proprietary band exactly (it's undocumented, and
// we only have raw HRV — not Garmin's baseline). mean ± 1 SD over ~90 days is a
// tunable approximation that reproduces the *behaviour*, not the exact ms.
const BASELINE_DAYS = 90; // long, slow-moving personal baseline window
const ROLLING_DAYS = 7; // window for the rolling average that gets classified
const UNBALANCED_SD = 1; // balanced band = baseline mean ± this many SD
const MIN_BASELINE_SAMPLES = 21; // ≈ Garmin's 3-week warm-up; else status is null (grey)
const MIN_ROLLING_SAMPLES = 2;

function shiftIsoDate(iso: string, days: number): string {
  return toISODate(new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS));
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[], m: number): number {
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length);
}

/** dateStr → hrv, for records with a non-null HRV reading. */
function buildHrvByDate(records: IIntervalsWellness[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of records) {
    if (r.hrv != null) map.set(r.id, r.hrv);
  }
  return map;
}

export interface HrvAssessment {
  /** 7-day rolling average of nightly HRV — the value Garmin plots & classifies. */
  rollingAvg: number | null;
  status: HrvStatus;
  baseline: IHrvBaseline | null;
}

/**
 * Garmin's per-day rule: the 7-day rolling average is `balanced` when it sits
 * inside the baseline band (inclusive) and `unbalanced` when it falls outside on
 * either side. Pure & deterministic — this is the behaviour covered by tests.
 */
export function classifyHrv(rollingAvg: number, baseline: IHrvBaseline): "balanced" | "unbalanced" {
  return rollingAvg < baseline.lowerBalanced || rollingAvg > baseline.upperBalanced
    ? "unbalanced"
    : "balanced";
}

/**
 * HRV assessment for `targetDate`: the trailing 7-day rolling average, the
 * slow-moving baseline band (mean ± 1 SD over ~90 days, for shading the chart),
 * and the resulting status. `baseline`/`status` are null until there's enough
 * history (mirrors Garmin's ~3-week warm-up).
 */
export function computeHrvAssessment(
  hrvByDate: Map<string, number>,
  targetDate: string,
): HrvAssessment {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const recent: number[] = [];
  const baseline: number[] = [];

  for (const [dateStr, hrv] of hrvByDate) {
    const diffDays = Math.round((target - new Date(`${dateStr}T00:00:00Z`).getTime()) / DAY_MS);
    if (diffDays < 0) continue; // only history up to (and including) the target day
    if (diffDays < ROLLING_DAYS) recent.push(hrv);
    if (diffDays < BASELINE_DAYS) baseline.push(hrv);
  }

  const rollingAvg = recent.length >= MIN_ROLLING_SAMPLES ? mean(recent) : null;

  if (baseline.length < MIN_BASELINE_SAMPLES) {
    return { rollingAvg, status: null, baseline: null };
  }

  const baselineMean = mean(baseline);
  const baselineSd = stdDev(baseline, baselineMean);
  const band: IHrvBaseline = {
    mean: baselineMean,
    lowerBalanced: baselineMean - UNBALANCED_SD * baselineSd,
    upperBalanced: baselineMean + UNBALANCED_SD * baselineSd,
  };

  return {
    rollingAvg,
    status: rollingAvg == null ? null : classifyHrv(rollingAvg, band),
    baseline: band,
  };
}

function buildFitnessPoint(w: IIntervalsWellness, hrv: HrvAssessment): IFitnessPoint {
  const { ctl, atl } = w;
  // The raw nightly reading classified against the same band, so individual
  // nights outside the band can be colored independently of the 7-day average.
  const nightlyStatus =
    w.hrv != null && hrv.baseline != null ? classifyHrv(w.hrv, hrv.baseline) : null;
  return {
    date: w.id,
    ctl,
    atl,
    tsb: ctl != null && atl != null ? ctl - atl : null,
    ctlLoad: w.ctlLoad,
    atlLoad: w.atlLoad,
    hrv: w.hrv,
    hrv7dAvg: hrv.rollingAvg,
    hrvStatus: hrv.status,
    hrvNightlyStatus: nightlyStatus,
    hrvBaseline: hrv.baseline,
    sleepScore: w.sleepScore,
  };
}

/**
 * Daily CTL/ATL/TSB/load + HRV(+status) + sleep score over [oldest, newest].
 * Fetches extra leading history so each point's hrvStatus has a full baseline,
 * then trims the output to the requested range.
 */
export async function fetchFitnessSeries(
  clerkUserId: string,
  oldest: string,
  newest: string,
): Promise<IFitnessSeriesResult> {
  const result = await withIntervalsToken(
    clerkUserId,
    async (accessToken): Promise<IFitnessSeriesResult> => {
      const extendedOldest = shiftIsoDate(oldest, -(BASELINE_DAYS + ROLLING_DAYS));
      const records = await intervalsApiService.getWellness(accessToken, extendedOldest, newest);

      const inRange = records.filter((r) => r.id >= oldest && r.id <= newest);
      if (inRange.length === 0) return { status: "no_data", data: null };

      const hrvByDate = buildHrvByDate(records);
      const points = inRange.map((r) =>
        buildFitnessPoint(r, computeHrvAssessment(hrvByDate, r.id)),
      );

      return { status: "ok", data: { range: { oldest, newest }, points } };
    },
  );
  return result.status === "not_linked" ? { status: "not_linked", data: null } : result.data;
}

/**
 * The fitness block for a single day (same shape as a series point), or null
 * when intervals.icu isn't linked or has no wellness record for that day.
 */
export async function fetchFitnessDayBlock(
  clerkUserId: string,
  date: string,
): Promise<IFitnessPoint | null> {
  const result = await withIntervalsToken(clerkUserId, async (accessToken) => {
    const extendedOldest = shiftIsoDate(date, -(BASELINE_DAYS + ROLLING_DAYS));
    const records = await intervalsApiService.getWellness(accessToken, extendedOldest, date);

    const dayRecord = records.find((r) => r.id === date);
    if (!dayRecord) return null;

    const hrvByDate = buildHrvByDate(records);
    return buildFitnessPoint(dayRecord, computeHrvAssessment(hrvByDate, date));
  });
  return result.status === "not_linked" ? null : result.data;
}
