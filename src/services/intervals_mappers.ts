import type { InsertActivity } from "../schema";
import type { IIntervalsActivity, IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import type { Lap } from "../types/strava/IDetailedActivity";
import type { StreamSet } from "../types/strava/IStream";

// intervals.icu returns start_date_local as naïve local time (no `Z`). We store
// local times as UTC instants, so parse the naïve string as UTC.
function parseIntervalsLocalStart(value: string): Date {
  const normalized = value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return new Date(normalized);
}

/**
 * intervals.icu Activity → DB row, the intervals-only counterpart to
 * strava_mappers.getDbInsertActivity. Used by the master-sync path to create
 * local rows for activities that have no Strava source. `stravaActivityId` is
 * null (these never came from Strava); `intervalsIcuId` carries the link.
 * Enrichment metrics are layered on separately via buildEnrichment.
 */
export function mapIntervalsActivityToInsert(
  activity: IIntervalsActivity,
  userId: string,
): InsertActivity {
  return {
    userId,
    stravaActivityId: null,
    intervalsIcuId: activity.id,
    title: activity.name?.trim() || "Untitled activity",
    description: activity.description,
    sportType: activity.type || "Workout",
    distance: activity.distance ?? 0,
    movingTime: activity.moving_time ?? 0,
    elapsedTime: activity.elapsed_time ?? null,
    totalElevationGain: activity.total_elevation_gain ?? null,
    averageHeartRate: activity.average_heartrate ?? null,
    startDateLocal: parseIntervalsLocalStart(activity.start_date_local),
    indoor: activity.trainer ?? false,
  };
}

/**
 * intervals.icu DTO → internal (Strava-shaped) mappers. The pipeline's canonical
 * stream/laps shapes are the Strava `StreamSet` and `Lap`; these adapters let
 * intervals.icu be a drop-in source. Pure functions — also used by the
 * master-sync path.
 */

type IntervalsStream = { type?: unknown; data?: unknown };

function asNumberArray(data: unknown): number[] | null {
  return Array.isArray(data) ? (data as number[]) : null;
}

/**
 * Map intervals.icu's `[{ type, data }]` stream array onto the internal
 * StreamSet. intervals.icu's `type` keys mirror Strava's, so `velocity_smooth`,
 * `heartrate`, `watts`, `distance`, `altitude`, `cadence`, `time` map straight
 * across. Types absent for an activity are simply left undefined.
 */
export function mapIntervalsStreamsToStreamSet(raw: unknown): StreamSet {
  const out: StreamSet = {};
  if (!Array.isArray(raw)) return out;

  for (const entry of raw as IntervalsStream[]) {
    const data = asNumberArray(entry.data);
    if (!data) continue;
    switch (entry.type) {
      case "time":
        out.time = { data };
        break;
      case "distance":
        out.distance = { data };
        break;
      case "altitude":
        out.altitude = { data };
        break;
      case "velocity_smooth":
        out.velocity_smooth = { data };
        break;
      case "heartrate":
        out.heartrate = { data };
        break;
      case "cadence":
        out.cadence = { data };
        break;
      case "watts":
        out.watts = { data };
        break;
      case "moving":
        out.moving = { data: data.map((v) => v !== 0) };
        break;
    }
  }
  return out;
}

/**
 * intervals.icu's /activity/{id}/intervals returns a wrapper object
 * (e.g. { icu_intervals: [...] }) rather than a bare array. Pull out the
 * interval list defensively so a shape change can't crash the caller.
 */
export function extractIntervalsList(raw: unknown): IIntervalsInterval[] {
  if (Array.isArray(raw)) return raw as IIntervalsInterval[];
  if (raw && typeof raw === "object") {
    const wrapper = raw as Record<string, unknown>;
    const candidate = wrapper.icu_intervals ?? wrapper.intervals;
    if (Array.isArray(candidate)) return candidate as IIntervalsInterval[];
  }
  return [];
}

/**
 * Map intervals.icu intervals onto the internal `Lap` shape that
 * `lap_derivation_service` consumes. Only the fields that code actually reads
 * are populated meaningfully (`distance`, `moving_time`, `elapsed_time`,
 * `average_speed`, `start_index`, `end_index`, HR); the rest are filled with
 * neutral defaults. `average_speed` falls back to distance/time when
 * intervals.icu omits it, so lap matching still works.
 */
export function mapIntervalsToLaps(intervals: IIntervalsInterval[]): Lap[] {
  return intervals.map((iv, idx) => {
    const movingTime = iv.moving_time ?? 0;
    const elapsedTime = iv.elapsed_time ?? movingTime;
    const averageSpeed =
      iv.average_speed ?? (movingTime > 0 ? (iv.distance ?? 0) / movingTime : 0);
    return {
      id: iv.id,
      resource_state: 2,
      name: iv.label ?? `Interval ${idx + 1}`,
      activity: { id: 0, resource_state: 2 },
      athlete: { id: 0, resource_state: 2 },
      elapsed_time: elapsedTime,
      moving_time: movingTime,
      start_date: "",
      start_date_local: "",
      distance: iv.distance ?? 0,
      start_index: iv.start_index,
      end_index: iv.end_index,
      total_elevation_gain: 0,
      average_speed: averageSpeed,
      max_speed: 0,
      average_cadence: 0,
      device_watts: iv.average_watts != null,
      average_watts: iv.average_watts ?? 0,
      average_heartrate: iv.average_heartrate ?? undefined,
      max_heartrate: iv.max_heartrate ?? undefined,
      lap_index: idx,
      split: idx + 1,
    } satisfies Lap;
  });
}

/** Convenience: raw intervals wrapper → internal `Lap[]` in one call. */
export function mapIntervalsRawToLaps(raw: unknown): Lap[] {
  return mapIntervalsToLaps(extractIntervalsList(raw));
}
