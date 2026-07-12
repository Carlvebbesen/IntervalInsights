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

function buildFitnessPoint(w: IIntervalsWellness, hrv: HrvAssessment): IFitnessPoint {
  const { ctl, atl } = w;
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

export async function fetchFitnessSeries(
  userId: string,
  oldest: string,
  newest: string,
): Promise<IFitnessSeriesResult> {
  const result = await withIntervalsToken(
    userId,
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

export async function fetchFitnessDayBlock(
  userId: string,
  date: string,
): Promise<IFitnessPoint | null> {
  const result = await withIntervalsToken(userId, async (accessToken) => {
    const extendedOldest = shiftIsoDate(date, -(BASELINE_DAYS + ROLLING_DAYS));
    const records = await intervalsApiService.getWellness(accessToken, extendedOldest, date);

    const dayRecord = records.find((r) => r.id === date);
    if (!dayRecord) return null;

    const hrvByDate = buildHrvByDate(records);
    return buildFitnessPoint(dayRecord, computeHrvAssessment(hrvByDate, date));
  });
  return result.status === "not_linked" ? null : result.data;
}
