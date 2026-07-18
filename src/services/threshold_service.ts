import { logger } from "../logger";
import {
  getOrCreateUserSettings,
  updateUserSettings,
} from "../repositories/user_settings_repository";
import { RUNNING_SPORT_TYPES, type Sex } from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsAthlete } from "../types/intervals/IIntervalsActivity";
import type { IIntervalsWellness } from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";
import { withIntervalsToken } from "./intervals_token_helper";
import { fetchPaceAnchor } from "./pace_anchor_service";
import { toISODate } from "./utils";

type Db = IGlobalBindings["db"];

export type ThresholdPaceSource = "manual" | "pace_anchor" | null;

export interface ResolvedThresholds {
  thresholdPaceMps: number | null;
  thresholdPaceSource: ThresholdPaceSource;
  lthr: number | null;
  restingHr: number | null;
  maxHr: number | null;
  ftp: number | null;
  sex: Sex | null;
}

const SEED_WELLNESS_WINDOW_DAYS = 42;

function extractLthr(athlete: IIntervalsAthlete): number | null {
  const settings = athlete.sportSettings ?? [];
  const running = new Set<string>(RUNNING_SPORT_TYPES);
  const runSetting = settings.find((s) => s.lthr != null && s.types?.some((t) => running.has(t)));
  if (runSetting?.lthr != null) return runSetting.lthr;
  const anySetting = settings.find((s) => s.lthr != null);
  return anySetting?.lthr ?? athlete.lthr ?? null;
}

function latestRestingHr(records: IIntervalsWellness[]): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rhr = records[i].restingHR;
    if (rhr != null) return rhr;
  }
  return null;
}

/**
 * Seed-once fill of null lthr/restingHr from the linked intervals.icu account
 * (athlete sport settings + recent wellness). Fills nulls only, never
 * overwrites; swallows API failures. Returns the values to use downstream.
 */
async function seedHrThresholds(
  db: Db,
  userId: string,
  asOf: Date,
  current: { lthr: number | null; restingHr: number | null },
): Promise<{ lthr: number | null; restingHr: number | null }> {
  if (current.lthr != null && current.restingHr != null) return current;

  try {
    const result = await withIntervalsToken(userId, async (accessToken) => {
      const newest = toISODate(asOf);
      const oldestDate = new Date(asOf);
      oldestDate.setUTCDate(oldestDate.getUTCDate() - SEED_WELLNESS_WINDOW_DAYS);
      const [athlete, wellness] = await Promise.all([
        intervalsApiService.getAthlete(accessToken),
        intervalsApiService.getWellness(accessToken, toISODate(oldestDate), newest),
      ]);
      return {
        lthr: extractLthr(athlete),
        restingHr: latestRestingHr(wellness),
      };
    });
    if (result.status === "not_linked") return current;

    const updates: { lthr?: number; restingHr?: number } = {};
    const next = { ...current };
    if (current.lthr == null && result.data.lthr != null) {
      updates.lthr = result.data.lthr;
      next.lthr = result.data.lthr;
    }
    if (current.restingHr == null && result.data.restingHr != null) {
      updates.restingHr = result.data.restingHr;
      next.restingHr = result.data.restingHr;
    }
    if (Object.keys(updates).length > 0) {
      await updateUserSettings(db, userId, updates);
    }
    return next;
  } catch (err) {
    logger.warn({ err, userId }, "HR-threshold seed from intervals.icu failed");
    return current;
  }
}

/**
 * Resolve the athlete's load thresholds for a given point in time.
 *
 * `thresholdPaceMps` prefers the manual override, else the pace-anchor
 * critical-speed. `lthr`/`restingHr` are seeded once from intervals.icu when
 * null and a link exists. `maxHr` comes from settings; `ftp`/`sex` pass through.
 */
export async function resolveThresholds(
  db: Db,
  userId: string,
  opts?: { asOf?: Date },
): Promise<ResolvedThresholds> {
  const asOf = opts?.asOf ?? new Date();
  const settings = await getOrCreateUserSettings(db, userId);

  const seeded = await seedHrThresholds(db, userId, asOf, {
    lthr: settings.lthr,
    restingHr: settings.restingHr,
  });

  let thresholdPaceMps = settings.thresholdPaceMps;
  let thresholdPaceSource: ThresholdPaceSource = thresholdPaceMps != null ? "manual" : null;
  if (thresholdPaceMps == null) {
    const anchor = await fetchPaceAnchor(db, userId, asOf);
    if (
      anchor.status === "ok" &&
      anchor.data.anchorSource === "critical_speed" &&
      anchor.data.criticalSpeedMps != null
    ) {
      thresholdPaceMps = anchor.data.criticalSpeedMps;
      thresholdPaceSource = "pace_anchor";
    }
  }

  return {
    thresholdPaceMps,
    thresholdPaceSource,
    lthr: seeded.lthr,
    restingHr: seeded.restingHr,
    maxHr: settings.maxHeartRate,
    ftp: settings.ftp,
    sex: settings.sex,
  };
}
