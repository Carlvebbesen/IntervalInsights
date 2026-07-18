import { logger } from "../logger";
import type { IGlobalBindings } from "../types/IRouters";
import type {
  HrvStatus,
  IFitnessPoint,
  IFitnessSeriesResult,
  IHrvBaseline,
} from "../types/intervals/IFitness";
import type { IIntervalsWellness } from "../types/intervals/IIntervalsWellness";
import {
  computeFitnessDay,
  computeFitnessSeries,
  type FitnessMetricsPoint,
} from "./fitness_metrics_service";
import { intervalsApiService } from "./intervals_api_service";
import { withIntervalsToken } from "./intervals_token_helper";
import { isReviewUser } from "./review_account";
import { getDemoCorpus } from "./review_demo/corpus_cache";
import { toISODate } from "./utils";

type Db = IGlobalBindings["db"];

const DAY_MS = 86_400_000;

const BASELINE_DAYS = 90;
const ROLLING_DAYS = 7;
const UNBALANCED_SD = 1;
const MIN_BASELINE_SAMPLES = 21;
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

function buildHrvByDate(records: IIntervalsWellness[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of records) {
    if (r.hrv != null) map.set(r.id, r.hrv);
  }
  return map;
}

export interface HrvAssessment {
  rollingAvg: number | null;
  status: HrvStatus;
  baseline: IHrvBaseline | null;
}

export function classifyHrv(rollingAvg: number, baseline: IHrvBaseline): "balanced" | "unbalanced" {
  return rollingAvg < baseline.lowerBalanced || rollingAvg > baseline.upperBalanced
    ? "unbalanced"
    : "balanced";
}

export function computeHrvAssessment(
  hrvByDate: Map<string, number>,
  targetDate: string,
): HrvAssessment {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const recent: number[] = [];
  const baseline: number[] = [];

  for (const [dateStr, hrv] of hrvByDate) {
    const diffDays = Math.round((target - new Date(`${dateStr}T00:00:00Z`).getTime()) / DAY_MS);
    if (diffDays < 0) continue;
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

// CTL/ATL/TSB/load now come from the self-computed fold; HRV/sleep data points
// still merge in from the intervals.icu wellness record for that day (null when
// the account isn't linked). See project note self-computed-fitness-metrics.
function buildFitnessPoint(
  metrics: FitnessMetricsPoint,
  w: IIntervalsWellness | undefined,
  hrv: HrvAssessment,
): IFitnessPoint {
  const nightlyStatus =
    w?.hrv != null && hrv.baseline != null ? classifyHrv(w.hrv, hrv.baseline) : null;
  return {
    date: metrics.date,
    ctl: metrics.ctl,
    atl: metrics.atl,
    tsb: metrics.tsb,
    ctlLoad: metrics.load,
    atlLoad: metrics.load,
    hrv: w?.hrv ?? null,
    hrv7dAvg: hrv.rollingAvg,
    hrvStatus: hrv.status,
    hrvNightlyStatus: nightlyStatus,
    hrvBaseline: hrv.baseline,
    sleepScore: w?.sleepScore ?? null,
  };
}

async function fetchWellnessRecords(
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellness[]> {
  try {
    const result = await withIntervalsToken(userId, (accessToken) =>
      intervalsApiService.getWellness(accessToken, oldest, newest),
    );
    return result.status === "ok" ? result.data : [];
  } catch (err) {
    logger.error({ err }, "Intervals.icu wellness fetch failed (fitness series)");
    return [];
  }
}

export async function fetchFitnessSeries(
  db: Db,
  userId: string,
  oldest: string,
  newest: string,
  sport?: string,
): Promise<IFitnessSeriesResult> {
  if (isReviewUser(userId)) {
    const points = getDemoCorpus().fitnessSeries.filter(
      (p) => p.date >= oldest && p.date <= newest,
    );
    return { status: "ok", data: { range: { oldest, newest }, points } };
  }

  const metrics = await computeFitnessSeries(db, userId, { oldest, newest, sport });
  if (metrics.length === 0) return { status: "no_data", data: null };

  const extendedOldest = shiftIsoDate(oldest, -(BASELINE_DAYS + ROLLING_DAYS));
  const records = await fetchWellnessRecords(userId, extendedOldest, newest);
  const byDate = new Map(records.map((r) => [r.id, r]));
  const hrvByDate = buildHrvByDate(records);

  const points = metrics.map((m) =>
    buildFitnessPoint(m, byDate.get(m.date), computeHrvAssessment(hrvByDate, m.date)),
  );
  return { status: "ok", data: { range: { oldest, newest }, points } };
}

export async function fetchFitnessDayBlock(
  db: Db,
  userId: string,
  date: string,
): Promise<IFitnessPoint | null> {
  if (isReviewUser(userId)) {
    return getDemoCorpus().fitnessSeries.find((p) => p.date === date) ?? null;
  }

  const metrics = await computeFitnessDay(db, userId, date);
  if (!metrics) return null;

  const extendedOldest = shiftIsoDate(date, -(BASELINE_DAYS + ROLLING_DAYS));
  const records = await fetchWellnessRecords(userId, extendedOldest, date);
  const dayRecord = records.find((r) => r.id === date);
  const hrvByDate = buildHrvByDate(records);
  return buildFitnessPoint(metrics, dayRecord, computeHrvAssessment(hrvByDate, date));
}
