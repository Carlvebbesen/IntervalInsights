import {
  computeBaselineVolume,
  mapActiveHealthEvents,
} from "../agent/planning/nodes/gather_context";
import {
  DEFAULT_INTENSITY_AGGRESSIVENESS,
  DEFAULT_VOLUME_AGGRESSIVENESS,
  INTENSITY_AGGRESSIVENESS,
  type IntensityAggressiveness,
  VOLUME_AGGRESSIVENESS,
  type VolumeAggressiveness,
} from "../agent/planning/plan_builder_state";
import { logger } from "../logger";
import * as dashboardRepo from "../repositories/dashboard_repository";
import * as eventRepo from "../repositories/event_repository";
import * as raceEventRepo from "../repositories/race_event_repository";
import * as planRepo from "../repositories/training_plan_repository";
import { RUNNING_SPORT_TYPES } from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";
import type { PlanGuardContext } from "./plan_guard_service";

type Db = IGlobalBindings["db"];

type RunRow = { startDateLocal: Date | string; distance: number | string | null };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function asVolumeAggressiveness(value: unknown): VolumeAggressiveness {
  return VOLUME_AGGRESSIVENESS.includes(value as VolumeAggressiveness)
    ? (value as VolumeAggressiveness)
    : DEFAULT_VOLUME_AGGRESSIVENESS;
}

function asIntensityAggressiveness(value: unknown): IntensityAggressiveness {
  return INTENSITY_AGGRESSIVENESS.includes(value as IntensityAggressiveness)
    ? (value as IntensityAggressiveness)
    : DEFAULT_INTENSITY_AGGRESSIVENESS;
}

function asLongRunDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value <= 6 ? value : null;
}

/**
 * Assemble the athlete context the plan guards compare against: the five dials
 * stored on `training_plans.meta.settings` at plan creation, plus everything
 * that must reflect reality NOW rather than a creation-time snapshot — trailing
 * volume, recent longest run, and above all active injuries, whose status
 * changes long after the plan was built.
 *
 * Every block degrades independently to null/[] like `gather_context` does: a
 * context-load failure downgrades the guards to silence, it never fails the write.
 *
 * Deliberately separate from `resolveReadiness` (suggest_session_service), which
 * is intervals.icu-backed; this path stays self-computed so Strava-only athletes
 * are still guarded.
 */
export async function loadPlanGuardContext(
  db: Db,
  userId: string,
  planId: number,
): Promise<PlanGuardContext> {
  const log = logger.child({ service: "planGuardContext", userId, planId });

  let settings: Record<string, unknown> = {};
  let raceEventId: number | null = null;
  try {
    const meta = await planRepo.findMetaForUser(db, userId, planId);
    settings = asRecord(asRecord(meta).settings);
    const plan = await planRepo.findByIdForUser(db, userId, planId);
    raceEventId = plan?.raceEventId ?? null;
  } catch (err) {
    log.warn({ err }, "plan settings load failed — falling back to defaults");
  }

  const now = new Date();

  let baselineWeeklyMeters: number | null = null;
  let longestRunMeters: number | null = null;
  try {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 30);
    const runs = (await dashboardRepo.runsBetween(
      db,
      userId,
      [...RUNNING_SPORT_TYPES],
      from,
      now,
    )) as RunRow[];
    const baseline = computeBaselineVolume(runs, now);
    baselineWeeklyMeters = baseline.trailing4WeekAvgWeeklyMeters;
    longestRunMeters = baseline.longestRunLast30dMeters;
  } catch (err) {
    log.warn({ err }, "baseline volume failed — degrading to null");
  }

  let raceDistanceMeters: number | null = null;
  if (raceEventId != null) {
    try {
      const race = await raceEventRepo.findByIdForUser(db, userId, raceEventId);
      raceDistanceMeters = race?.distanceMeters ?? null;
    } catch (err) {
      log.warn({ err }, "race event load failed — degrading to null");
    }
  }

  let activeInjuries: PlanGuardContext["activeInjuries"] = [];
  try {
    const rows = await eventRepo.listForUser(db, userId, { status: "active" });
    activeInjuries = mapActiveHealthEvents(rows);
  } catch (err) {
    log.warn({ err }, "active health events failed — degrading to empty");
  }

  return {
    volumeAggressiveness: asVolumeAggressiveness(settings.volumeAggressiveness),
    intensityAggressiveness: asIntensityAggressiveness(settings.intensityAggressiveness),
    maxWeeklyVolumeMeters: asPositiveInt(settings.maxWeeklyVolumeMeters),
    daysPerWeek: asPositiveInt(settings.daysPerWeek),
    preferredLongRunDay: asLongRunDay(settings.preferredLongRunDay),
    baselineWeeklyMeters,
    longestRunMeters,
    raceDistanceMeters,
    activeInjuries,
  };
}
