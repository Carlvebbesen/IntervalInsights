import { logger } from "../logger";
import type { IGlobalBindings } from "../types/IRouters";
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

interface WellnessLoad {
  /** True when the intervals.icu token resolved (regardless of records). */
  linked: boolean;
  records: IIntervalsWellness[];
}

// Wellness now supplies only pure data points (HRV, sleep, resting HR, weight,
// …). A fetch failure must not sink the self-computed fitness half, so it
// degrades to no records rather than throwing.
async function loadWellness(userId: string, oldest: string, newest: string): Promise<WellnessLoad> {
  try {
    const result = await withIntervalsToken(userId, (accessToken) =>
      intervalsApiService.getWellness(accessToken, oldest, newest),
    );
    if (result.status === "not_linked") return { linked: false, records: [] };
    return { linked: true, records: result.data };
  } catch (err) {
    logger.error({ err }, "Intervals.icu wellness fetch failed");
    return { linked: true, records: [] };
  }
}

// P3 parallel-run signal: while intervals.icu is still linked, emit the computed
// CTL/ATL against intervals' own values so the deltas can be watched before the
// cutover. Only fires when a wellness record is present (i.e. linked with data).
function logFitnessParallelDelta(
  userId: string,
  source: string,
  computed: FitnessMetricsPoint | null,
  wellness: IIntervalsWellness | null,
): void {
  if (!wellness) return;
  const { ctl: icuCtl, atl: icuAtl } = wellness;
  logger.info(
    {
      userId,
      source,
      computedCtl: computed?.ctl ?? null,
      computedAtl: computed?.atl ?? null,
      icuCtl,
      icuAtl,
      deltaCtl: computed && icuCtl != null ? computed.ctl - icuCtl : null,
      deltaAtl: computed && icuAtl != null ? computed.atl - icuAtl : null,
    },
    "fitness parallel-run delta",
  );
}

export async function fetchWellnessSummary(
  db: Db,
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellnessSummary | null> {
  if (isReviewUser(userId)) return getDemoCorpus().wellnessSummary;

  const metricsPoint = await computeFitnessDay(db, userId, newest);
  const { records } = await loadWellness(userId, oldest, newest);
  const latest = records.length > 0 ? records[records.length - 1] : null;

  logFitnessParallelDelta(userId, "wellness_summary", metricsPoint, latest);

  if (!metricsPoint && records.length === 0) return null;

  let hrvSum = 0;
  let hrvCount = 0;
  let sleepSum = 0;
  let sleepCount = 0;
  for (const w of records) {
    if (w.hrv != null) {
      hrvSum += w.hrv;
      hrvCount++;
    }
    if (w.sleepQuality != null) {
      sleepSum += w.sleepQuality;
      sleepCount++;
    }
  }

  return {
    ctl: metricsPoint?.ctl ?? null,
    atl: metricsPoint?.atl ?? null,
    tsb: metricsPoint?.tsb ?? null,
    avgHrv: hrvCount > 0 ? hrvSum / hrvCount : null,
    avgSleepQuality: sleepCount > 0 ? sleepSum / sleepCount : null,
    restingHr: latest?.restingHR ?? null,
  };
}

export async function fetchTrainingSummary(
  db: Db,
  userId: string,
  date?: string,
): Promise<IIntervalsTrainingSummaryResult> {
  if (isReviewUser(userId)) return { status: "ok", data: getDemoCorpus().trainingSummary };

  const newestDate = date ? new Date(`${date}T00:00:00Z`) : new Date();
  const newest = toISODate(newestDate);
  const oldest = toISODate(new Date(newestDate.getTime() - 7 * DAY_MS));

  const metricsPoint = await computeFitnessDay(db, userId, newest);
  const { linked, records } = await loadWellness(userId, oldest, newest);
  const latest = records.length > 0 ? records[records.length - 1] : null;

  logFitnessParallelDelta(userId, "training_summary", metricsPoint, latest);

  if (!metricsPoint) {
    return { status: linked ? "no_recent_data" : "not_linked", data: null };
  }

  return {
    status: "ok",
    data: {
      date: metricsPoint.date,
      fitness: {
        ctl: metricsPoint.ctl,
        atl: metricsPoint.atl,
        rampRate: metricsPoint.rampRate,
        ctlLoad: metricsPoint.load,
        atlLoad: metricsPoint.load,
      },
      sleep: {
        sleepSecs: latest?.sleepSecs ?? null,
        sleepScore: latest?.sleepScore ?? null,
      },
      recovery: {
        restingHR: latest?.restingHR ?? null,
        hrv: latest?.hrv ?? null,
        readiness: latest?.readiness ?? null,
        baevskySI: latest?.baevskySI ?? null,
        spO2: latest?.spO2 ?? null,
        respiration: latest?.respiration ?? null,
      },
      body: {
        weight: latest?.weight ?? null,
        vo2max: latest?.vo2max ?? null,
      },
    },
  };
}

const COMPUTED_METRIC_READERS = {
  ctl: (m: FitnessMetricsPoint) => m.ctl,
  atl: (m: FitnessMetricsPoint) => m.atl,
  tsb: (m: FitnessMetricsPoint) => m.tsb,
  rampRate: (m: FitnessMetricsPoint) => m.rampRate,
  ctlLoad: (m: FitnessMetricsPoint) => m.load,
  atlLoad: (m: FitnessMetricsPoint) => m.load,
} satisfies Partial<Record<NumericMetric, (m: FitnessMetricsPoint) => number | null>>;

type ComputedMetric = keyof typeof COMPUTED_METRIC_READERS;

function isComputedMetric(key: NumericMetric): key is ComputedMetric {
  return key in COMPUTED_METRIC_READERS;
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

// The six fitness metrics read from the computed fold; everything else from the
// wellness record for that day.
function readMetric(
  key: NumericMetric,
  m: FitnessMetricsPoint | undefined,
  w: IIntervalsWellness | undefined,
): number | null {
  if (isComputedMetric(key)) return m ? COMPUTED_METRIC_READERS[key](m) : null;
  return w ? METRIC_READERS[key](w) : null;
}

function buildMergedPoint(
  date: string,
  m: FitnessMetricsPoint | undefined,
  w: IIntervalsWellness | undefined,
): IIntervalsWellnessPoint {
  return {
    date,
    fitness: {
      ctl: m?.ctl ?? null,
      atl: m?.atl ?? null,
      tsb: m?.tsb ?? null,
      rampRate: m?.rampRate ?? null,
      ctlLoad: m?.load ?? null,
      atlLoad: m?.load ?? null,
    },
    sleep: {
      sleepSecs: w?.sleepSecs ?? null,
      sleepScore: w?.sleepScore ?? null,
      sleepQuality: w?.sleepQuality ?? null,
    },
    recovery: {
      restingHR: w?.restingHR ?? null,
      hrv: w?.hrv ?? null,
      readiness: w?.readiness ?? null,
      baevskySI: w?.baevskySI ?? null,
      spO2: w?.spO2 ?? null,
      respiration: w?.respiration ?? null,
    },
    subjective: {
      soreness: w?.soreness ?? null,
      fatigue: w?.fatigue ?? null,
      stress: w?.stress ?? null,
      mood: w?.mood ?? null,
      motivation: w?.motivation ?? null,
    },
    health: {
      injury: w?.injury ?? null,
      sickness: w?.sickness ?? null,
    },
    body: {
      weight: w?.weight ?? null,
      bodyFat: w?.bodyFat ?? null,
      vo2max: w?.vo2max ?? null,
    },
    comments: w?.comments ?? null,
  };
}

export async function fetchWeekWellnessStats(
  db: Db,
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWeekWellness | null> {
  if (isReviewUser(userId)) return getDemoCorpus().weekWellness;

  const series = await computeFitnessSeries(db, userId, { oldest, newest });
  const { records } = await loadWellness(userId, oldest, newest);

  if (series.length === 0 && records.length === 0) return null;

  let sleepSum = 0;
  let sleepCount = 0;
  let fatigueSum = 0;
  let fatigueCount = 0;
  for (const r of records) {
    if (r.sleepScore != null) {
      sleepSum += r.sleepScore;
      sleepCount++;
    }
    if (r.fatigue != null) {
      fatigueSum += r.fatigue;
      fatigueCount++;
    }
  }

  const lastPoint = series.length > 0 ? series[series.length - 1] : null;
  const totalLoad = series.reduce((sum, p) => sum + p.load, 0);

  logFitnessParallelDelta(
    userId,
    "week_wellness",
    lastPoint,
    records.length > 0 ? records[records.length - 1] : null,
  );

  return {
    avgSleepScore: sleepCount > 0 ? sleepSum / sleepCount : null,
    avgFatigue: fatigueCount > 0 ? fatigueSum / fatigueCount : null,
    fitness: lastPoint?.ctl ?? null,
    form: lastPoint?.tsb ?? null,
    totalLoad: series.length > 0 ? totalLoad : null,
  };
}

export async function fetchWellnessSeries(
  db: Db,
  userId: string,
  oldest: string,
  newest: string,
): Promise<IIntervalsWellnessSeriesResult> {
  if (isReviewUser(userId)) {
    const series = getDemoCorpus().wellnessSeries;
    const points = series.points.filter((p) => p.date >= oldest && p.date <= newest);
    return {
      status: "ok",
      data: {
        range: { oldest, newest },
        metricsAvailable: series.metricsAvailable,
        summary: series.summary,
        points,
      },
    };
  }

  const metrics = await computeFitnessSeries(db, userId, { oldest, newest });
  const { linked, records } = await loadWellness(userId, oldest, newest);

  if (metrics.length === 0 && records.length === 0) {
    return { status: linked ? "no_data" : "not_linked", data: null };
  }

  logFitnessParallelDelta(
    userId,
    "wellness_series",
    metrics.length > 0 ? metrics[metrics.length - 1] : null,
    records.length > 0 ? records[records.length - 1] : null,
  );

  const computedByDate = new Map(metrics.map((m) => [m.date, m]));
  const wellnessByDate = new Map(records.map((r) => [r.id, r]));
  const allDates = [...new Set([...computedByDate.keys(), ...wellnessByDate.keys()])].sort();

  type Acc = { min: number | null; max: number | null; sum: number; count: number };
  const acc = {} as Record<NumericMetric, Acc>;
  for (const key of NUMERIC_METRICS) {
    acc[key] = { min: null, max: null, sum: 0, count: 0 };
  }

  for (const date of allDates) {
    const m = computedByDate.get(date);
    const w = wellnessByDate.get(date);
    for (const key of NUMERIC_METRICS) {
      const value = readMetric(key, m, w);
      if (value == null) continue;
      const a = acc[key];
      if (a.min == null || value < a.min) a.min = value;
      if (a.max == null || value > a.max) a.max = value;
      a.sum += value;
      a.count++;
    }
  }

  const lastComputed = metrics.length > 0 ? metrics[metrics.length - 1] : undefined;
  const lastWellness = records.length > 0 ? records[records.length - 1] : undefined;
  const summary = {} as Record<NumericMetric, IIntervalsMetricStats>;
  const metricsAvailable: NumericMetric[] = [];
  for (const key of NUMERIC_METRICS) {
    const a = acc[key];
    summary[key] = {
      latest: readMetric(key, lastComputed, lastWellness),
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
      points: allDates.map((d) =>
        buildMergedPoint(d, computedByDate.get(d), wellnessByDate.get(d)),
      ),
    },
  };
}
