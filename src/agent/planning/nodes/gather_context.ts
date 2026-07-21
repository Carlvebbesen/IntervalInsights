import type { RunnableConfig } from "@langchain/core/runnables";
import { AppError } from "../../../error";
import { logger } from "../../../logger";
import * as dashboardRepo from "../../../repositories/dashboard_repository";
import * as noteRepo from "../../../repositories/event_note_repository";
import type { EventDao } from "../../../repositories/event_repository";
import * as eventRepo from "../../../repositories/event_repository";
import * as intervalStructureRepo from "../../../repositories/interval_structure_repository";
import * as raceEventRepo from "../../../repositories/race_event_repository";
import * as userRepo from "../../../repositories/user_repository";
import { findOrCreateUserSettings } from "../../../repositories/user_settings_repository";
import { RUNNING_SPORT_TYPES, type TrainingType, trainingTypeEnum } from "../../../schema/enums";
import { computeFitnessDay } from "../../../services/fitness_metrics_service";
import {
  fetchPaceAnchor,
  type PaceAnchorResult,
  predictRaceTimeSecFromVdot,
} from "../../../services/pace_anchor_service";
import { toISODate } from "../../../services/utils";
import { DEFAULT_BASELINE_WEEKLY_METERS, MIN_BASELINE_WEEKLY_METERS } from "../guards";
import type { PlanNotice } from "../plan_builder_schemas";
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

// Proven-capacity window: a comeback athlete's months-scale history, so a few
// low weeks (vacation, illness) do not make the ramp treat them like a novice.
export const PROVEN_CAPACITY_WINDOW_WEEKS = 26;
// A trailing-4-week slice only counts as a proven block when most of it was
// actually run — one big week inside three empty ones is a spike, not capacity.
export const PROVEN_MIN_ACTIVE_WEEKS = 3;

/**
 * Real baseline running volume — the anti-over-ramp anchor. `trailing4WeekAvg`
 * is the mean weekly running distance over the last 28 days; `longestRun` is
 * the single longest run in the last 30 days. The proven fields look back
 * `PROVEN_CAPACITY_WINDOW_WEEKS` (see `AthleteBaselineVolume`). Null means "no
 * usable data at all" — callers must treat it as "no baseline on record",
 * never as zero. Any real running produces a number, however small. Pure over
 * the supplied rows so it is unit-testable.
 */
export function computeBaselineVolume(runs: RunRow[], today: Date): AthleteBaselineVolume {
  const absent: AthleteBaselineVolume = {
    trailing4WeekAvgWeeklyMeters: null,
    longestRunLast30dMeters: null,
    provenWeeklyMeters: null,
    provenLongestRunMeters: null,
  };
  if (runs.length === 0) return absent;
  const nowMs = today.getTime();
  const cutoff28 = nowMs - 28 * DAY_MS;
  const cutoff30 = nowMs - 30 * DAY_MS;

  let sum28 = 0;
  let count28 = 0;
  let longest30 = 0;
  let any30 = false;
  const weekTotals = new Array<number>(PROVEN_CAPACITY_WINDOW_WEEKS).fill(0);
  let longestProven = 0;
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
    const weekIdx = Math.floor((nowMs - t) / (7 * DAY_MS));
    if (weekIdx >= 0 && weekIdx < PROVEN_CAPACITY_WINDOW_WEEKS) {
      weekTotals[weekIdx] += dist;
      if (dist > longestProven) longestProven = dist;
    }
  }

  let proven: number | null = null;
  for (let k = 0; k + 4 <= PROVEN_CAPACITY_WINDOW_WEEKS; k++) {
    const slice = weekTotals.slice(k, k + 4);
    if (slice.filter((m) => m > 0).length < PROVEN_MIN_ACTIVE_WEEKS) continue;
    const avg = Math.round(slice.reduce((a, b) => a + b, 0) / 4);
    proven = Math.max(proven ?? 0, avg);
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
    provenWeeklyMeters: proven,
    provenLongestRunMeters: longestProven > 0 ? Math.round(longestProven) : null,
  };
}

/** Map active injury/illness rows to the plan-facing constraint shape. The
 * summary text now lives in each event's anchor note (events.description was
 * dropped), passed in as an eventId → anchor-note map. */
export function mapActiveHealthEvents(
  rows: EventDao[],
  anchorNotes: Map<number, { note: string }>,
): ActiveHealthEvent[] {
  return rows
    .filter((r) => r.status === "active")
    .map((r) => ({
      type: r.eventType,
      bodyLocation: r.bodyLocation ?? null,
      description: anchorNotes.get(r.id)?.note ?? "",
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

  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 8 * 7);

  type Degradation = { code: string; message: string };

  const RACE_ABILITY_NOTICE: Degradation = {
    code: "context_race_ability_unavailable",
    message:
      "Your race-ability estimate (recent best efforts) could not be read, so paces and targets were set without it — review them carefully or retry later.",
  };
  const VOCABULARY_NOTICE: Degradation = {
    code: "context_vocabulary_unavailable",
    message:
      "Your workout history could not be read, so sessions were chosen without knowing which workout types you already do — review them carefully or retry later.",
  };

  const loadRace = async (): Promise<AthleteContext["race"]> => {
    if (state.input.raceEventId == null) return null;
    const r = await raceEventRepo.findByIdForUser(db, state.userId, state.input.raceEventId);
    if (!r) throw new AppError(404, "Race event not found or unauthorized");
    return {
      name: r.name,
      date: r.date,
      distanceMeters: r.distanceMeters,
      targetTimeSeconds: r.targetTimeSeconds,
      priority: r.priority,
    };
  };

  // Self-computed (DB-only) fitness for EVERY athlete, incl. Strava-only —
  // no intervals.icu token required.
  const loadFitness = async (): Promise<{
    value: AthleteContext["fitness"];
    notice?: Degradation;
  }> => {
    try {
      const point = await computeFitnessDay(db, state.userId, toISODate(now));
      if (!point) return { value: null };
      return {
        value: {
          ctl: round1(point.ctl),
          atl: round1(point.atl),
          tsb: round1(point.tsb),
          rampRate: round1(point.rampRate),
        },
      };
    } catch (err) {
      log.warn({ err }, "computeFitnessDay failed — degrading fitness to null");
      return {
        value: null,
        notice: {
          code: "context_fitness_unavailable",
          message:
            "Your current fitness metrics (form/fatigue) could not be read, so this plan was built without them — review the early weeks carefully or retry later.",
        },
      };
    }
  };

  const loadAnchor = async (): Promise<{
    value: PaceAnchorResult | null;
    notice?: Degradation;
  }> => {
    try {
      return { value: await fetchPaceAnchor(db, state.userId, now) };
    } catch (err) {
      log.warn({ err }, "pace anchor failed — degrading raceAbility to null");
      return { value: null, notice: RACE_ABILITY_NOTICE };
    }
  };

  const loadBaseline = async (): Promise<{
    value: AthleteContext["baselineVolume"];
    notice?: Degradation;
  }> => {
    try {
      // Wide enough for the proven-capacity window; the 28/30-day trailing
      // fields filter inside computeBaselineVolume.
      const from = new Date(now);
      from.setUTCDate(from.getUTCDate() - PROVEN_CAPACITY_WINDOW_WEEKS * 7);
      const runs = (await dashboardRepo.runsBetween(
        db,
        state.userId,
        [...RUNNING_SPORT_TYPES],
        from,
        now,
      )) as RunRow[];
      return { value: computeBaselineVolume(runs, now) };
    } catch (err) {
      log.warn({ err }, "baseline volume failed — degrading to null");
      return {
        value: null,
        notice: {
          code: "context_baseline_unavailable",
          message:
            "Your recent running volume could not be read, so this plan starts from a generic baseline instead of what you actually run — review the first weeks carefully or retry later.",
        },
      };
    }
  };

  const loadHealthEvents = async (): Promise<{
    value: ActiveHealthEvent[];
    notice?: Degradation;
  }> => {
    try {
      const eventRows = await eventRepo.listForUser(db, state.userId, { status: "active" });
      const anchors = await noteRepo.anchorNotesFor(
        db,
        eventRows.map((r) => r.id),
      );
      return { value: mapActiveHealthEvents(eventRows, anchors) };
    } catch (err) {
      log.warn({ err }, "active health events failed — degrading to empty");
      return {
        value: [],
        notice: {
          code: "context_health_events_unavailable",
          message:
            "Your injury/illness records could not be read, so this plan was built WITHOUT injury accommodations — review it carefully or retry later.",
        },
      };
    }
  };

  const loadStructures = async (): Promise<{
    value: StructureRow[] | null;
    notice?: Degradation;
  }> => {
    try {
      return { value: await intervalStructureRepo.listDistinctForUser(db, state.userId) };
    } catch (err) {
      log.warn({ err }, "workout vocabulary failed — degrading to empty");
      return { value: null, notice: VOCABULARY_NOTICE };
    }
  };

  // All reads are independent; only the race-event 404 may fail the node, and
  // Promise.all propagates it as before. Notices are pushed in a fixed order
  // below (the old sequential order), so degradations stay deterministic.
  const [user, settings, race, rows, fitnessRes, anchorRes, baselineRes, healthRes, structuresRes] =
    await Promise.all([
      userRepo.findById(db, state.userId),
      findOrCreateUserSettings(db, state.userId),
      loadRace(),
      dashboardRepo.runWeeksWithTypeSince(db, state.userId, [...RUNNING_SPORT_TYPES], since),
      loadFitness(),
      loadAnchor(),
      loadBaseline(),
      loadHealthEvents(),
      loadStructures(),
    ]);

  const maxHeartRate = settings?.maxHeartRate ?? user?.maxHeartRate ?? null;
  const weekRows = rows as WeekRow[];
  const recentWeeks = foldWeeks(weekRows);
  const fitness = fitnessRes.value;
  const baselineVolume = baselineRes.value;
  const activeHealthEvents = healthRes.value;

  let raceAbility: AthleteContext["raceAbility"] = null;
  let raceAbilityNotice = anchorRes.notice;
  if (anchorRes.value?.status === "ok") {
    try {
      const a = anchorRes.value.data;
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
    } catch (err) {
      log.warn({ err }, "pace anchor failed — degrading raceAbility to null");
      raceAbility = null;
      raceAbilityNotice = RACE_ABILITY_NOTICE;
    }
  }

  let workoutVocabulary: WorkoutVocabulary = {
    types: [],
    hasStructuredIntervalHistory: false,
    structures: [],
  };
  let vocabularyNotice = structuresRes.notice;
  if (structuresRes.value != null) {
    try {
      workoutVocabulary = extractWorkoutVocabulary(weekRows, structuresRes.value);
    } catch (err) {
      log.warn({ err }, "workout vocabulary failed — degrading to empty");
      workoutVocabulary = { types: [], hasStructuredIntervalHistory: false, structures: [] };
      vocabularyNotice = VOCABULARY_NOTICE;
    }
  }

  // Every degradation above MUST surface to the athlete, not just the logs: a
  // plan silently built without injury records is the bug this list prevents.
  // `kind: "clamped"` is reused because the wizard parses kind as a closed enum.
  const contextNotices: PlanNotice[] = [];
  for (const notice of [
    fitnessRes.notice,
    raceAbilityNotice,
    baselineRes.notice,
    healthRes.notice,
    vocabularyNotice,
  ]) {
    if (notice) contextNotices.push({ kind: "clamped", ...notice });
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
    contextNotices,
  };
}
