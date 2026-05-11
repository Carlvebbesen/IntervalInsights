import { IntervalsError } from "../error";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import type {
  IIntervalsTrainingSummaryResult,
  IIntervalsWellnessSummary,
} from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";
import { toISODate } from "./utils";

export async function fetchWellnessSummary(
  clerkUserId: string,
  oldest: string,
  newest: string
): Promise<IIntervalsWellnessSummary | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(clerkUserId);
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
    console.error("Intervals.icu wellness fetch failed:", err);
    return null;
  }
}

export async function fetchTrainingSummary(
  clerkUserId: string,
): Promise<IIntervalsTrainingSummaryResult> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(clerkUserId);
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
