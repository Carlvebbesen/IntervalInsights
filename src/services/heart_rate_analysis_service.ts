import { eq } from "drizzle-orm";
import type { z } from "zod";
import { runInBackground } from "../background";
import { AppError } from "../error";
import type { Logger } from "../logger";
import type { HrAnalysisFilters, HrAnalysisRow } from "../repositories/activity_repository";
import * as activityRepo from "../repositories/activity_repository";
import { intervalSegments } from "../schema";
import { RUNNING_SPORT_TYPES, type TrainingType } from "../schema/enums";
import type {
  HeartRateAnalysisResponseSchema,
  HrAnalysisPointSchema,
  HrMetricSummarySchema,
  HrZoneSchema,
} from "../schemas/api_schemas";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsAthlete } from "../types/intervals/IIntervalsActivity";
import type { StreamSet } from "../types/strava/IStream";
import { getStreamSet } from "./activity_source_service";
import { userHasHeartRateConsent } from "./heart_rate_consent_service";
import {
  computeActivityHrStats,
  computeWorkHrStats,
  type WorkWindowSegment,
} from "./hr_stats_service";
import { intervalsApiService } from "./intervals_api_service";
import { mapIntervalsStreamsToStreamSet } from "./intervals_mappers";
import { withIntervalsToken } from "./intervals_token_helper";
import { isReviewUser } from "./review_account";
import { getDemoCorpus } from "./review_demo/corpus_cache";

type Db = IGlobalBindings["db"];
type Result = z.infer<typeof HeartRateAnalysisResponseSchema>;
type Point = z.infer<typeof HrAnalysisPointSchema>;
type Zone = z.infer<typeof HrZoneSchema>;
type MetricSummary = z.infer<typeof HrMetricSummarySchema>;

export interface HeartRateAnalysisFilters extends HrAnalysisFilters {
  intervalsOnly?: boolean;
}

const ZONE_PALETTE = ["#22C55E", "#3B82F6", "#F59E0B", "#EF4444", "#7C3AED", "#EC4899", "#14B8A6"];

const MAX_SYNC_LAZY_COMPUTES = 15;

const METRIC_KEYS = ["avgHr", "maxHr", "medianHr", "modeHr"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

export async function getHeartRateAnalysis(
  db: Db,
  userId: string,
  filters: HeartRateAnalysisFilters,
  logger: Logger,
): Promise<Result> {
  const log = logger.child({ service: "heartRateAnalysis" });

  if (isReviewUser(userId)) return analyzeForReview(db, userId, filters, log);

  const result = await withIntervalsToken(userId, (intervalsToken) =>
    analyzeWithToken(db, userId, intervalsToken, filters, log),
  );
  return result.status === "not_linked" ? { status: "not_linked" } : result.data;
}

// The demo user has no intervals.icu token: HR stats come from the seeded DB
// rows (HR columns pre-filled) and zones from the corpus instead of the
// intervals.icu athlete profile. The consent gate still applies.
async function analyzeForReview(
  db: Db,
  userId: string,
  filters: HeartRateAnalysisFilters,
  log: Logger,
): Promise<Result> {
  const consent = await userHasHeartRateConsent(db, userId);
  if (!consent) {
    throw new AppError(403, "Heart-rate processing not enabled for this account");
  }

  const rows = await activityRepo.listForHrAnalysis(db, userId, filters);
  if (rows.length === 0) return { status: "no_data" };

  await fillMissingStats(db, userId, rows, log);

  const intervalsOnly = filters.intervalsOnly === true;
  const points = rows.map((row) => toPoint(row, intervalsOnly));
  const zones = getDemoCorpus().hrZones;
  const summaries = buildSummaries(points);

  return { status: "ok", points, zones, summaries };
}

async function analyzeWithToken(
  db: Db,
  userId: string,
  intervalsToken: string,
  filters: HeartRateAnalysisFilters,
  log: Logger,
): Promise<Result> {
  const consent = await userHasHeartRateConsent(db, userId);
  if (!consent) {
    throw new AppError(403, "Heart-rate processing not enabled for this account");
  }

  const rows = await activityRepo.listForHrAnalysis(db, userId, filters);
  if (rows.length === 0) {
    return { status: "no_data" };
  }

  await fillMissingStats(db, userId, rows, log);

  const intervalsOnly = filters.intervalsOnly === true;
  const points = rows.map((row) => toPoint(row, intervalsOnly));

  const zones = await fetchZones(intervalsToken, log);

  const summaries = buildSummaries(points);

  return { status: "ok", points, zones, summaries };
}

function round(value: number | null): number | null {
  return value == null ? null : Math.round(value);
}

export function toPoint(row: HrAnalysisRow, intervalsOnly: boolean): Point {
  const avg = intervalsOnly ? row.workAvgHeartRate : row.averageHeartRate;
  const max = intervalsOnly ? row.workMaxHeartRate : row.maxHeartRate;
  const median = intervalsOnly ? row.workMedianHeartRate : row.medianHeartRate;
  const mode = intervalsOnly ? row.workModeHeartRate : row.modeHeartRate;
  return {
    activityId: row.id,
    date: row.startDateLocal.toISOString(),
    name: row.title,
    trainingType: row.trainingType as TrainingType | null,
    avgHr: round(avg),
    maxHr: round(max),
    medianHr: round(median),
    modeHr: round(mode),
  };
}

async function fillMissingStats(
  db: Db,
  userId: string,
  rows: HrAnalysisRow[],
  log: Logger,
): Promise<void> {
  const missing = rows.filter((r) => r.hrStatsComputedAt == null && r.hasHeartrate === true);
  if (missing.length === 0) return;

  const sync = missing.slice(0, MAX_SYNC_LAZY_COMPUTES);
  const deferred = missing.slice(MAX_SYNC_LAZY_COMPUTES);

  for (const row of sync) {
    try {
      await computeAndPersistRow(db, userId, row);
    } catch (err) {
      log.warn({ err, activityId: row.id }, "lazy HR-stat computation failed");
    }
  }

  if (deferred.length > 0) {
    log.info({ deferred: deferred.length }, "backfilling remaining HR stats in background");
    runInBackground(
      "heartRate.backfillStats",
      async () => {
        for (const row of deferred) {
          try {
            await computeAndPersistRow(db, userId, row);
          } catch (err) {
            log.warn({ err, activityId: row.id }, "background HR-stat computation failed");
          }
        }
      },
      { logger: log },
    );
  }
}

export function normalizeIntervalsStreams(raw: unknown): Pick<StreamSet, "time" | "heartrate"> {
  const { time, heartrate } = mapIntervalsStreamsToStreamSet(raw);
  return { time, heartrate };
}

export async function computeAndPersistRow(
  db: Db,
  userId: string,
  row: HrAnalysisRow,
): Promise<void> {
  let streams: Pick<StreamSet, "time" | "heartrate">;
  try {
    streams = await getStreamSet(db, userId, row.id, ["time", "heartrate"]);
  } catch (err) {
    if (row.stravaActivityId != null) throw err;
    await activityRepo.updateHrStats(db, row.id, { full: null, work: null });
    row.hrStatsComputedAt = new Date();
    return;
  }

  const segments = await db
    .select({
      type: intervalSegments.type,
      timeSeriesEndTime: intervalSegments.timeSeriesEndTime,
      actualDuration: intervalSegments.actualDuration,
    })
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, row.id));

  const full = computeActivityHrStats(streams);
  const work = computeWorkHrStats(streams, segments as WorkWindowSegment[]);

  await activityRepo.updateHrStats(db, row.id, { full, work });

  row.medianHeartRate = full?.median ?? null;
  row.modeHeartRate = full?.mode ?? null;
  row.workAvgHeartRate = work?.avg ?? null;
  row.workMaxHeartRate = work?.max ?? null;
  row.workMedianHeartRate = work?.median ?? null;
  row.workModeHeartRate = work?.mode ?? null;
  if (full) {
    row.averageHeartRate = row.averageHeartRate ?? full.avg;
    row.maxHeartRate = row.maxHeartRate ?? full.max;
  }
  row.hrStatsComputedAt = new Date();
}

async function fetchZones(intervalsToken: string, log: Logger): Promise<Zone[]> {
  try {
    const athlete = await intervalsApiService.getAthlete(intervalsToken);
    return buildHrZones(athlete);
  } catch (err) {
    log.warn({ err }, "failed to fetch intervals.icu HR zones — returning none");
    return [];
  }
}

export function buildHrZones(athlete: IIntervalsAthlete): Zone[] {
  const settings = athlete.sportSettings ?? [];
  const runningTypes = new Set<string>(RUNNING_SPORT_TYPES);
  const chosen =
    settings.find((s) => s.hr_zones?.length && s.types?.some((t) => runningTypes.has(t))) ??
    settings.find((s) => s.hr_zones?.length);

  const uppers = (chosen?.hr_zones ?? []).filter((v) => v > 0).sort((a, b) => a - b);
  if (uppers.length === 0) return [];

  const names = chosen?.hr_zone_names ?? [];
  const bands: Zone[] = [];
  let prev = 0;
  for (let i = 0; i < uppers.length; i++) {
    bands.push({
      label: names[i] ?? `Z${i + 1}`,
      min: prev,
      max: uppers[i],
      color: ZONE_PALETTE[i % ZONE_PALETTE.length],
    });
    prev = uppers[i];
  }
  return bands;
}

function metricValue(point: Point, key: MetricKey): number | null {
  return point[key];
}

export function buildSummaries(points: Point[]): Record<string, MetricSummary> {
  const summaries: Record<string, MetricSummary> = {};
  for (const key of METRIC_KEYS) {
    let min: { activityId: number; value: number } | null = null;
    let max: { activityId: number; value: number } | null = null;
    let sum = 0;
    let count = 0;
    for (const point of points) {
      const value = metricValue(point, key);
      if (value == null) continue;
      if (min == null || value < min.value) min = { activityId: point.activityId, value };
      if (max == null || value > max.value) max = { activityId: point.activityId, value };
      sum += value;
      count++;
    }
    if (count === 0) continue;
    summaries[key] = { min, max, mean: sum / count };
  }
  return summaries;
}
