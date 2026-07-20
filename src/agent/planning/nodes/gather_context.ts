import type { RunnableConfig } from "@langchain/core/runnables";
import { AppError } from "../../../error";
import { logger } from "../../../logger";
import * as dashboardRepo from "../../../repositories/dashboard_repository";
import type { EventDao } from "../../../repositories/event_repository";
import * as eventRepo from "../../../repositories/event_repository";
import * as intervalStructureRepo from "../../../repositories/interval_structure_repository";
import * as raceEventRepo from "../../../repositories/race_event_repository";
import * as userRepo from "../../../repositories/user_repository";
import { findOrCreateUserSettings } from "../../../repositories/user_settings_repository";
import { RUNNING_SPORT_TYPES, type TrainingType, trainingTypeEnum } from "../../../schema/enums";
import { computeFitnessDay } from "../../../services/fitness_metrics_service";
import { fetchPaceAnchor, predictRaceTimeSecFromVdot } from "../../../services/pace_anchor_service";
import { DEFAULT_BASELINE_WEEKLY_METERS, MIN_BASELINE_WEEKLY_METERS } from "../guards";
import type {
  ActiveHealthEvent,
  AthleteBaselineVolume,
  AthleteContext,
  AthleteWeekSummary,
  PlanBuilderConfigurable,
  PlanBuilderState,
  WorkoutVocabulary,
} from "../plan_builder_state";

type WeekRow = {
  weekStart: string;
  trainingType: string | null;
  sessions: number;
  totalDistance: string | number | null;
};

type RunRow = { startDateLocal: Date | string; distance: number | string | null };

const DAY_MS = 24 * 60 * 60 * 1000;

// Training types that reflect genuine structured-interval experience — a
// continuous TEMPO or PROGRESSIVE_LONG doesn't count as "has run reps before".
const STRUCTURED_INTERVAL_TYPES: readonly TrainingType[] = [
  "SHORT_INTERVALS",
  "LONG_INTERVALS",
  "SPRINTS",
  "HILL_SPRINTS",
  "FARTLEK",
];

const VALID_TRAINING_TYPES = new Set<string>(trainingTypeEnum.enumValues);

function toISODate(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}

// Minimum evidence before a computed trailing average is trusted as a full
// training baseline. Below either threshold the 28-day window is thin enough
// that the divide-by-4 may understate the athlete — but understating is the
// safe direction, so we report the observed average anyway, capped at the
// re-entry floor. Only an empty window reports ABSENT and hands over to
// DEFAULT_BASELINE_WEEKLY_METERS.
export const MIN_BASELINE_RUNS = 3;

/** A row's distance in meters, or null when absent/unparsable (never a silent 0). */
function runDistanceMeters(distance: number | string | null): number | null {
  if (distance == null) return null;
  const n = typeof distance === "string" ? Number.parseFloat(distance) : distance;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Real baseline running volume — the anti-over-ramp anchor. `trailing4WeekAvg`
 * is the mean weekly running distance over the last 28 days; `longestRun` is
 * the single longest run in the last 30 days. Null means "no usable data at
 * all" — callers must treat it as "no baseline on record", never as zero. Any
 * real running produces a number, however small. Pure over the supplied rows so
 * it is unit-testable.
 */
export function computeBaselineVolume(runs: RunRow[], today: Date): AthleteBaselineVolume {
  const absent = { trailing4WeekAvgWeeklyMeters: null, longestRunLast30dMeters: null };
  if (runs.length === 0) return absent;
  const nowMs = today.getTime();
  const cutoff28 = nowMs - 28 * DAY_MS;
  const cutoff30 = nowMs - 30 * DAY_MS;

  let sum28 = 0;
  let count28 = 0;
  let longest30 = 0;
  let any30 = false;
  for (const r of runs) {
    const t = (
      typeof r.startDateLocal === "string" ? new Date(r.startDateLocal) : r.startDateLocal
    ).getTime();
    if (!Number.isFinite(t)) continue;
    const dist = runDistanceMeters(r.distance);
    if (dist == null) continue;
    if (t >= cutoff30) {
      any30 = true;
      if (dist > longest30) longest30 = dist;
    }
    if (t >= cutoff28) {
      sum28 += dist;
      count28 += 1;
    }
  }

  // Thin data is still REAL data. Reporting a low-but-genuine average as null
  // hands the plan to the 20 km default, which for a 2 × 5 km/month athlete
  // anchors week 1 at ~2× what they actually run — the exact over-anchoring the
  // baseline exists to prevent. Only a completely empty window is "no baseline";
  // below the trust thresholds we still never report ABOVE what was observed.
  const avg = Math.round(sum28 / 4);
  const trusted = count28 >= MIN_BASELINE_RUNS && avg >= MIN_BASELINE_WEEKLY_METERS;
  return {
    trailing4WeekAvgWeeklyMeters:
      count28 === 0 ? null : trusted ? avg : Math.min(avg, DEFAULT_BASELINE_WEEKLY_METERS),
    longestRunLast30dMeters: any30 && longest30 > 0 ? Math.round(longest30) : null,
  };
}

/** Map active injury/illness rows to the plan-facing constraint shape. */
export function mapActiveHealthEvents(rows: EventDao[]): ActiveHealthEvent[] {
  return rows
    .filter((r) => r.status === "active")
    .map((r) => ({
      type: r.eventType,
      bodyLocation: r.bodyLocation ?? null,
      description: r.description,
      since: toISODate(r.startTime),
    }));
}

export const MAX_VOCABULARY_STRUCTURES = 8;

type StructureRow = { name: string; activityCount: number; lastDoneAt: Date | string | null };

/**
 * Session types the athlete has actually run (from their recent classified
 * activities), whether they have any genuine structured-interval history, and
 * their proven interval repertoire — the top structures by how often they were
 * done, then by recency — for the sessions agent to prefer over invented shapes.
 */
export function extractWorkoutVocabulary(
  rows: { trainingType: string | null }[],
  structureRows: StructureRow[],
): WorkoutVocabulary {
  const types = new Set<TrainingType>();
  for (const r of rows) {
    const t = r.trainingType;
    if (t && VALID_TRAINING_TYPES.has(t)) types.add(t as TrainingType);
  }
  const typeList = [...types];
  const recency = (s: StructureRow) =>
    s.lastDoneAt == null
      ? 0
      : (typeof s.lastDoneAt === "string" ? new Date(s.lastDoneAt) : s.lastDoneAt).getTime();
  const structures = [...structureRows]
    .sort((a, b) => b.activityCount - a.activityCount || recency(b) - recency(a))
    .slice(0, MAX_VOCABULARY_STRUCTURES)
    .map((s) => ({
      name: s.name,
      activityCount: s.activityCount,
      lastDoneAt: s.lastDoneAt == null ? null : toISODate(s.lastDoneAt),
    }));
  return {
    types: typeList,
    hasStructuredIntervalHistory:
      structureRows.length > 0 || typeList.some((t) => STRUCTURED_INTERVAL_TYPES.includes(t)),
    structures,
  };
}

function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}

function foldWeeks(rows: WeekRow[]): AthleteWeekSummary[] {
  const byWeek = new Map<string, AthleteWeekSummary>();
  for (const row of rows) {
    const key = row.weekStart;
    let week = byWeek.get(key);
    if (!week) {
      week = { weekStart: key, totalDistanceMeters: 0, typeCounts: {} };
      byWeek.set(key, week);
    }
    week.totalDistanceMeters += Number(row.totalDistance ?? 0);
    const type = row.trainingType ?? "UNCLASSIFIED";
    week.typeCounts[type] = (week.typeCounts[type] ?? 0) + Number(row.sessions ?? 0);
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export async function gatherContext(
  state: PlanBuilderState,
  config: RunnableConfig,
): Promise<Partial<PlanBuilderState>> {
  const { db } = config.configurable as PlanBuilderConfigurable;
  const log = logger.child({ node: "gatherContext", userId: state.userId });

  const user = await userRepo.findById(db, state.userId);
  const settings = await findOrCreateUserSettings(db, state.userId);
  const maxHeartRate = settings?.maxHeartRate ?? user?.maxHeartRate ?? null;

  let race: AthleteContext["race"] = null;
  if (state.input.raceEventId != null) {
    const r = await raceEventRepo.findByIdForUser(db, state.userId, state.input.raceEventId);
    if (!r) throw new AppError(404, "Race event not found or unauthorized");
    race = {
      name: r.name,
      date: r.date,
      distanceMeters: r.distanceMeters,
      targetTimeSeconds: r.targetTimeSeconds,
      priority: r.priority,
    };
  }

  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 8 * 7);
  const rows = (await dashboardRepo.runWeeksWithTypeSince(
    db,
    state.userId,
    [...RUNNING_SPORT_TYPES],
    since,
  )) as WeekRow[];
  const recentWeeks = foldWeeks(rows);

  // Self-computed (DB-only) fitness for EVERY athlete, incl. Strava-only —
  // no intervals.icu token required.
  let fitness: AthleteContext["fitness"] = null;
  try {
    const point = await computeFitnessDay(db, state.userId, toISODate(now));
    if (point) {
      fitness = {
        ctl: round1(point.ctl),
        atl: round1(point.atl),
        tsb: round1(point.tsb),
        rampRate: round1(point.rampRate),
      };
    }
  } catch (err) {
    log.warn({ err }, "computeFitnessDay failed — degrading fitness to null");
    fitness = null;
  }

  let raceAbility: AthleteContext["raceAbility"] = null;
  try {
    const anchor = await fetchPaceAnchor(db, state.userId, now);
    if (anchor.status === "ok") {
      const a = anchor.data;
      const predicted = a.predictedRaces.map((p) => ({
        distanceMeters: p.distanceM,
        timeSeconds: p.timeSec,
      }));
      if (
        race &&
        a.vdot != null &&
        !predicted.some((p) => p.distanceMeters === race.distanceMeters)
      ) {
        const t = predictRaceTimeSecFromVdot(a.vdot, race.distanceMeters);
        if (t != null) predicted.push({ distanceMeters: race.distanceMeters, timeSeconds: t });
      }
      raceAbility = { vdot: a.vdot, criticalSpeedMps: a.criticalSpeedMps, predicted };
    }
  } catch (err) {
    log.warn({ err }, "pace anchor failed — degrading raceAbility to null");
    raceAbility = null;
  }

  let baselineVolume: AthleteContext["baselineVolume"] = null;
  try {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 30);
    const runs = (await dashboardRepo.runsBetween(
      db,
      state.userId,
      [...RUNNING_SPORT_TYPES],
      from,
      now,
    )) as RunRow[];
    baselineVolume = computeBaselineVolume(runs, now);
  } catch (err) {
    log.warn({ err }, "baseline volume failed — degrading to null");
    baselineVolume = null;
  }

  let activeHealthEvents: ActiveHealthEvent[] = [];
  try {
    const eventRows = await eventRepo.listForUser(db, state.userId, { status: "active" });
    activeHealthEvents = mapActiveHealthEvents(eventRows);
  } catch (err) {
    log.warn({ err }, "active health events failed — degrading to empty");
    activeHealthEvents = [];
  }

  let workoutVocabulary: WorkoutVocabulary = {
    types: [],
    hasStructuredIntervalHistory: false,
    structures: [],
  };
  try {
    const structures = await intervalStructureRepo.listDistinctForUser(db, state.userId);
    workoutVocabulary = extractWorkoutVocabulary(rows, structures);
  } catch (err) {
    log.warn({ err }, "workout vocabulary failed — degrading to empty");
    workoutVocabulary = { types: [], hasStructuredIntervalHistory: false, structures: [] };
  }

  return {
    athleteContext: {
      athleteName: user?.name ?? null,
      maxHeartRate,
      intervalsConnected: !!user?.intervalsAthleteId,
      race,
      recentWeeks,
      fitness,
      raceAbility,
      baselineVolume,
      activeHealthEvents,
      workoutVocabulary,
    },
  };
}
