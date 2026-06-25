import { logger } from "../logger";
import {
  intervalRepEfforts,
  raceEfforts,
  type StoredEffortRow,
} from "../repositories/pace_anchor_repository";
import type { IGlobalBindings } from "../types/IRouters";
import { fetchBestEffortCurve } from "./intervals_curve_service";

type Db = IGlobalBindings["db"];

export type AnchorSource = "critical_speed" | "vdot" | "none";
export type AnchorConfidence = "high" | "medium" | "low";

export interface PaceSet {
  easySecPerKm: number | null;
  thresholdSecPerKm: number | null;
  intervalSecPerKm: number | null;
  repSecPerKm: number | null;
}

export interface PredictedRace {
  distanceM: number;
  timeSec: number;
}

export interface PaceAnchor {
  anchorSource: AnchorSource;
  confidence: AnchorConfidence;
  criticalSpeedMps: number | null;
  dPrimeM: number | null;
  vdot: number | null;
  paces: PaceSet;
  predictedRaces: PredictedRace[];
}

export type PaceAnchorResult =
  | { status: "not_linked"; data: null }
  | { status: "ok"; data: PaceAnchor };

const EMPTY_PACES: PaceSet = {
  easySecPerKm: null,
  thresholdSecPerKm: null,
  intervalSecPerKm: null,
  repSecPerKm: null,
};

const NONE_ANCHOR: PaceAnchor = {
  anchorSource: "none",
  confidence: "low",
  criticalSpeedMps: null,
  dPrimeM: null,
  vdot: null,
  paces: EMPTY_PACES,
  predictedRaces: [],
};

export interface MaximalEffort {
  durationSec: number;
  velocityMps: number;
  distanceM: number;
}

const CS_MIN_DURATION_SEC = 120;
const CS_MAX_DURATION_SEC = 900;

const CS_MIN_DURATION_SPREAD_SEC = 240;

const MIN_PLAUSIBLE_MPS = 2.0;
const MAX_PLAUSIBLE_MPS = 7.0;

function vo2Cost(velocityMetresPerMin: number): number {
  return (
    -4.6 + 0.182258 * velocityMetresPerMin + 0.000104 * velocityMetresPerMin * velocityMetresPerMin
  );
}

function pctVo2Max(durationMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMin) +
    0.2989558 * Math.exp(-0.1932605 * durationMin)
  );
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

export function linearRegression(points: { x: number; y: number }[]): LinearFit | null {
  const n = points.length;
  if (n < 2) return null;
  const distinctX = new Set(points.map((p) => p.x));
  if (distinctX.size < 2) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const { x, y } of points) {
    const predicted = slope * x + intercept;
    ssTot += (y - meanY) ** 2;
    ssRes += (y - predicted) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

export function computeCriticalSpeed(efforts: MaximalEffort[]): {
  criticalSpeedMps: number;
  dPrimeM: number;
  r2: number;
  pointCount: number;
} | null {
  const inDomain = efforts.filter(
    (e) =>
      e.durationSec >= CS_MIN_DURATION_SEC &&
      e.durationSec <= CS_MAX_DURATION_SEC &&
      e.velocityMps >= MIN_PLAUSIBLE_MPS &&
      e.velocityMps <= MAX_PLAUSIBLE_MPS,
  );
  if (inDomain.length < 2) return null;

  const durations = inDomain.map((e) => e.durationSec);
  const spread = Math.max(...durations) - Math.min(...durations);
  if (spread < CS_MIN_DURATION_SPREAD_SEC) return null;

  const fit = linearRegression(inDomain.map((e) => ({ x: e.durationSec, y: e.distanceM })));
  if (!fit) return null;

  const criticalSpeedMps = fit.slope;
  const dPrimeM = fit.intercept;
  if (criticalSpeedMps < MIN_PLAUSIBLE_MPS || criticalSpeedMps > MAX_PLAUSIBLE_MPS) return null;
  if (dPrimeM < 0) return null;

  return { criticalSpeedMps, dPrimeM, r2: fit.r2, pointCount: inDomain.length };
}

export function computeVdot(velocityMps: number, durationSec: number): number | null {
  if (velocityMps < MIN_PLAUSIBLE_MPS || velocityMps > MAX_PLAUSIBLE_MPS) return null;
  const t = durationSec / 60;
  if (t <= 0) return null;
  const v = velocityMps * 60;
  const pct = pctVo2Max(t);
  if (pct <= 0) return null;
  const vdot = vo2Cost(v) / pct;
  if (!Number.isFinite(vdot) || vdot <= 0) return null;
  return vdot;
}

const KM = 1000;

function mpsToSecPerKm(mps: number): number {
  return KM / mps;
}

function pacesFromCriticalSpeed(criticalSpeedMps: number): PaceSet {
  const thresholdSecPerKm = mpsToSecPerKm(criticalSpeedMps);
  return {
    easySecPerKm: Math.round(thresholdSecPerKm * 1.28),
    thresholdSecPerKm: Math.round(thresholdSecPerKm),
    intervalSecPerKm: Math.round(thresholdSecPerKm * 0.94),
    repSecPerKm: Math.round(thresholdSecPerKm * 0.89),
  };
}

function pacesFromVdot(vdot: number): PaceSet {
  const velocityForPct = (pct: number): number | null => {
    const vo2 = vdot * pct;
    const a = 0.000104;
    const b = 0.182258;
    const cc = -4.6 - vo2;
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return null;
    const vMetresPerMin = (-b + Math.sqrt(disc)) / (2 * a);
    if (vMetresPerMin <= 0) return null;
    const vMps = vMetresPerMin / 60;
    if (vMps < MIN_PLAUSIBLE_MPS || vMps > MAX_PLAUSIBLE_MPS) return null;
    return mpsToSecPerKm(vMps);
  };
  const round = (n: number | null) => (n == null ? null : Math.round(n));
  return {
    easySecPerKm: round(velocityForPct(0.7)),
    thresholdSecPerKm: round(velocityForPct(0.88)),
    intervalSecPerKm: round(velocityForPct(0.98)),
    repSecPerKm: round(velocityForPct(1.06)),
  };
}

export const RACE_DISTANCES_M = [5000, 10000, 21097.5, 42195];

export function predictRaceTimeSecFromVdot(vdot: number, distanceM: number): number | null {
  const demand = (durationMin: number): number =>
    vo2Cost(distanceM / durationMin) - vdot * pctVo2Max(durationMin);
  let lo = 0.1;
  let hi = 600;
  if (demand(lo) <= 0 || demand(hi) >= 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (demand(mid) > 0) lo = mid;
    else hi = mid;
  }
  const durationMin = (lo + hi) / 2;
  return Number.isFinite(durationMin) && durationMin > 0 ? Math.round(durationMin * 60) : null;
}

function predictRaces(vdot: number): PredictedRace[] {
  const races: PredictedRace[] = [];
  for (const distanceM of RACE_DISTANCES_M) {
    const timeSec = predictRaceTimeSecFromVdot(vdot, distanceM);
    if (timeSec != null) races.push({ distanceM, timeSec });
  }
  return races;
}

function pickVdotReference(efforts: MaximalEffort[]): MaximalEffort | null {
  const candidates = efforts.filter(
    (e) =>
      e.durationSec >= 180 &&
      e.durationSec <= 1200 &&
      e.velocityMps >= MIN_PLAUSIBLE_MPS &&
      e.velocityMps <= MAX_PLAUSIBLE_MPS,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, e) => (e.velocityMps > best.velocityMps ? e : best));
}

export function deriveAnchor(efforts: MaximalEffort[]): PaceAnchor {
  const ref = pickVdotReference(efforts);
  const vdot = ref ? computeVdot(ref.velocityMps, ref.durationSec) : null;
  const predictedRaces = vdot != null ? predictRaces(vdot) : [];

  const cs = computeCriticalSpeed(efforts);
  if (cs) {
    const confidence: AnchorConfidence =
      cs.pointCount >= 3 && cs.r2 >= 0.99 ? "high" : cs.r2 >= 0.97 ? "medium" : "low";
    return {
      anchorSource: "critical_speed",
      confidence,
      criticalSpeedMps: Number(cs.criticalSpeedMps.toFixed(4)),
      dPrimeM: Math.round(cs.dPrimeM),
      vdot: vdot != null ? Number(vdot.toFixed(1)) : null,
      paces: pacesFromCriticalSpeed(cs.criticalSpeedMps),
      predictedRaces,
    };
  }

  if (vdot != null) {
    return {
      anchorSource: "vdot",
      confidence: "medium",
      criticalSpeedMps: null,
      dPrimeM: null,
      vdot: Number(vdot.toFixed(1)),
      paces: pacesFromVdot(vdot),
      predictedRaces,
    };
  }

  return NONE_ANCHOR;
}

const STORED_WINDOW_DAYS = 120;

const MIN_STORED_EFFORTS = 2;

const DURATION_BUCKETS_SEC = [120, 180, 300, 600, 900, 1200];

function bucketForDuration(durationSec: number): number {
  return DURATION_BUCKETS_SEC.reduce((best, b) =>
    Math.abs(b - durationSec) < Math.abs(best - durationSec) ? b : best,
  );
}

function bestEffortsPerBucket(rows: StoredEffortRow[]): MaximalEffort[] {
  const byBucket = new Map<number, MaximalEffort>();
  for (const row of rows) {
    const velocityMps = row.distanceM / row.durationSec;
    if (velocityMps < MIN_PLAUSIBLE_MPS || velocityMps > MAX_PLAUSIBLE_MPS) continue;
    const bucket = bucketForDuration(row.durationSec);
    const existing = byBucket.get(bucket);
    if (!existing || velocityMps > existing.velocityMps) {
      byBucket.set(bucket, {
        durationSec: row.durationSec,
        distanceM: row.distanceM,
        velocityMps,
      });
    }
  }
  return [...byBucket.values()];
}

async function storedRunningEfforts(db: Db, userId: string, now: Date): Promise<MaximalEffort[]> {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - STORED_WINDOW_DAYS);

  const [reps, races] = await Promise.all([
    intervalRepEfforts(db, userId, since),
    raceEfforts(db, userId, since),
  ]);

  return bestEffortsPerBucket([...reps, ...races]);
}

export async function fetchPaceAnchor(
  db: Db,
  userId: string,
  clerkUserId: string,
  now: Date = new Date(),
): Promise<PaceAnchorResult> {
  try {
    const efforts = await storedRunningEfforts(db, userId, now);
    if (efforts.length >= MIN_STORED_EFFORTS) {
      return { status: "ok", data: deriveAnchor(efforts) };
    }

    const newest = toISODate(now);
    const oldestDate = new Date(now);
    oldestDate.setUTCDate(oldestDate.getUTCDate() - 90);
    const oldest = toISODate(oldestDate);

    const curve = await fetchBestEffortCurve(clerkUserId, {
      type: "Run",
      window: "custom",
      oldest,
      newest,
    });

    if (curve.status === "not_linked") return { status: "not_linked", data: null };
    if (curve.status === "no_data") return { status: "ok", data: NONE_ANCHOR };

    const curveEfforts: MaximalEffort[] = curve.data.points
      .filter((p) => typeof p.value === "number" && p.value > 0)
      .map((p) => ({
        durationSec: p.durationSecs,
        velocityMps: p.value,
        distanceM: p.value * p.durationSecs,
      }));

    if (curveEfforts.length === 0) return { status: "ok", data: NONE_ANCHOR };
    return { status: "ok", data: deriveAnchor(curveEfforts) };
  } catch (err) {
    logger.error({ err }, "Pace-anchor computation failed");
    return { status: "ok", data: NONE_ANCHOR };
  }
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
