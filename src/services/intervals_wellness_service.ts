import { IntervalsError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import type {
  IIntervalsMetricStats,
  IIntervalsTrainingSummaryResult,
  IIntervalsWeekWellness,
  IIntervalsWellness,
  IIntervalsWellnessPoint,
  IIntervalsWellnessSeriesResult,
  IIntervalsWellnessSummary,
  NumericMetric,
} from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";
import { withIntervalsToken } from "./intervals_token_helper";
import { toISODate } from "./utils";

export async function fetchWellnessSummary(
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellnessSummary | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(userId);
  } catch {
    return null;
  }

  try {
    const wellnessData = await intervalsApiService.getWellness(accessToken, oldest, newest);
    const latest = wellnessData.length > 0 ? wellnessData[wellnessData.length - 1] : null;

    let hrvSum = 0;
    let hrvCount = 0;
    let sleepSum = 0;
    let sleepCount = 0;
    for (const w of wellnessData) {
      if (w.hrv != null) {
        hrvSum += w.hrv;
        hrvCount++;
      }
      if (w.sleepQuality != null) {
        sleepSum += w.sleepQuality;
        sleepCount++;
      }
    }

    const ctl = latest?.ctl ?? null;
    const atl = latest?.atl ?? null;

    return {
      ctl,
      atl,
      tsb: ctl != null && atl != null ? ctl - atl : null,
      avgHrv: hrvCount > 0 ? hrvSum / hrvCount : null,
      avgSleepQuality: sleepCount > 0 ? sleepSum / sleepCount : null,
      restingHr: latest?.restingHR ?? null,
    };
  } catch (err) {
    logger.error({ err }, "Intervals.icu wellness fetch failed");
    return null;
  }
}

export async function fetchTrainingSummary(
  userId: string,
): Promise<IIntervalsTrainingSummaryResult> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(userId);
  } catch (err) {
    if (err instanceof IntervalsError && err.status === 403) {
      return { status: "not_linked", data: null };
    }
    throw err;
  }

  const now = new Date();
  const newest = toISODate(now);
  const oldest = toISODate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

  const records = await intervalsApiService.getWellness(accessToken, oldest, newest);
  if (records.length === 0) return { status: "no_recent_data", data: null };
  const latest = records[records.length - 1];

  return {
    status: "ok",
    data: {
      date: latest.id,
      fitness: {
        ctl: latest.ctl,
        atl: latest.atl,
        rampRate: latest.rampRate,
        ctlLoad: latest.ctlLoad,
        atlLoad: latest.atlLoad,
      },
      sleep: {
        sleepSecs: latest.sleepSecs,
        sleepScore: latest.sleepScore,
      },
      recovery: {
        restingHR: latest.restingHR,
        hrv: latest.hrv,
        readiness: latest.readiness,
        baevskySI: latest.baevskySI,
        spO2: latest.spO2,
        respiration: latest.respiration,
      },
      body: {
        weight: latest.weight,
        vo2max: latest.vo2max,
      },
    },
  };
}

const METRIC_READERS: Record<NumericMetric, (w: IIntervalsWellness) => number | null> = {
  ctl: (w) => w.ctl,
  atl: (w) => w.atl,
  tsb: (w) => (w.ctl != null && w.atl != null ? w.ctl - w.atl : null),
  rampRate: (w) => w.rampRate,
  ctlLoad: (w) => w.ctlLoad,
  atlLoad: (w) => w.atlLoad,
  sleepSecs: (w) => w.sleepSecs,
  sleepScore: (w) => w.sleepScore,
  sleepQuality: (w) => w.sleepQuality,
  restingHR: (w) => w.restingHR,
  hrv: (w) => w.hrv,
  readiness: (w) => w.readiness,
  baevskySI: (w) => w.baevskySI,
  spO2: (w) => w.spO2,
  respiration: (w) => w.respiration,
  soreness: (w) => w.soreness,
  fatigue: (w) => w.fatigue,
  stress: (w) => w.stress,
  mood: (w) => w.mood,
  motivation: (w) => w.motivation,
  injury: (w) => w.injury,
  sickness: (w) => w.sickness,
  weight: (w) => w.weight,
  bodyFat: (w) => w.bodyFat,
  vo2max: (w) => w.vo2max,
};

const NUMERIC_METRICS = Object.keys(METRIC_READERS) as NumericMetric[];

function buildPoint(w: IIntervalsWellness): IIntervalsWellnessPoint {
  return {
    date: w.id,
    fitness: {
      ctl: w.ctl,
      atl: w.atl,
      tsb: w.ctl != null && w.atl != null ? w.ctl - w.atl : null,
      rampRate: w.rampRate,
      ctlLoad: w.ctlLoad,
      atlLoad: w.atlLoad,
    },
    sleep: {
      sleepSecs: w.sleepSecs,
      sleepScore: w.sleepScore,
      sleepQuality: w.sleepQuality,
    },
    recovery: {
      restingHR: w.restingHR,
      hrv: w.hrv,
      readiness: w.readiness,
      baevskySI: w.baevskySI,
      spO2: w.spO2,
      respiration: w.respiration,
    },
    subjective: {
      soreness: w.soreness,
      fatigue: w.fatigue,
      stress: w.stress,
      mood: w.mood,
      motivation: w.motivation,
    },
    health: {
      injury: w.injury,
      sickness: w.sickness,
    },
    body: {
      weight: w.weight,
      bodyFat: w.bodyFat,
      vo2max: w.vo2max,
    },
    comments: w.comments,
  };
}

export async function fetchWeekWellnessStats(
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWeekWellness | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(userId);
  } catch {
    return null;
  }

  let records: IIntervalsWellness[];
  try {
    records = await intervalsApiService.getWellness(accessToken, oldest, newest);
  } catch (err) {
    logger.error({ err }, "Intervals.icu week wellness fetch failed");
    return null;
  }

  if (records.length === 0) return null;

  let sleepSum = 0;
  let sleepCount = 0;
  let fatigueSum = 0;
  let fatigueCount = 0;
  let loadSum = 0;
  let loadCount = 0;
  for (const r of records) {
    if (r.sleepScore != null) {
      sleepSum += r.sleepScore;
      sleepCount++;
    }
    if (r.fatigue != null) {
      fatigueSum += r.fatigue;
      fatigueCount++;
    }
    if (r.atlLoad != null) {
      loadSum += r.atlLoad;
      loadCount++;
    }
  }

  const latest = records[records.length - 1];
  const fitness = latest.ctl;
  const form = latest.ctl != null && latest.atl != null ? latest.ctl - latest.atl : null;

  return {
    avgSleepScore: sleepCount > 0 ? sleepSum / sleepCount : null,
    avgFatigue: fatigueCount > 0 ? fatigueSum / fatigueCount : null,
    fitness,
    form,
    totalLoad: loadCount > 0 ? loadSum : null,
  };
}

export async function fetchWellnessSeries(
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellnessSeriesResult> {
  const result = await withIntervalsToken(userId, (accessToken) =>
    fetchWellnessSeriesWithToken(accessToken, oldest, newest),
  );
  return result.status === "not_linked" ? { status: "not_linked", data: null } : result.data;
}

async function fetchWellnessSeriesWithToken(
  accessToken: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellnessSeriesResult> {
  const records = await intervalsApiService.getWellness(accessToken, oldest, newest);
  if (records.length === 0) return { status: "no_data", data: null };

  type Acc = { min: number | null; max: number | null; sum: number; count: number };
  const acc = {} as Record<NumericMetric, Acc>;
  for (const key of NUMERIC_METRICS) {
    acc[key] = { min: null, max: null, sum: 0, count: 0 };
  }

  for (const record of records) {
    for (const key of NUMERIC_METRICS) {
      const value = METRIC_READERS[key](record);
      if (value == null) continue;
      const a = acc[key];
      if (a.min == null || value < a.min) a.min = value;
      if (a.max == null || value > a.max) a.max = value;
      a.sum += value;
      a.count++;
    }
  }

  const lastRecord = records[records.length - 1];
  const summary = {} as Record<NumericMetric, IIntervalsMetricStats>;
  const metricsAvailable: NumericMetric[] = [];
  for (const key of NUMERIC_METRICS) {
    const a = acc[key];
    summary[key] = {
      latest: METRIC_READERS[key](lastRecord),
      min: a.min,
      max: a.max,
      avg: a.count > 0 ? a.sum / a.count : null,
    };
    if (a.count > 0) metricsAvailable.push(key);
  }

  return {
    status: "ok",
    data: {
      range: { oldest, newest },
      metricsAvailable,
      summary,
      points: records.map(buildPoint),
    },
  };
}
