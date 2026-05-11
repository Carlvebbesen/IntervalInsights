import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import type { IIntervalsWellnessSummary } from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";

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
    const [wellnessData, fitnessData] = await Promise.all([
      intervalsApiService.getWellness(accessToken, oldest, newest),
      intervalsApiService.getFitnessModel(accessToken, oldest, newest),
    ]);

    const latestFitness = fitnessData.length > 0 ? fitnessData[fitnessData.length - 1] : null;
    const latestWellness = wellnessData.length > 0 ? wellnessData[wellnessData.length - 1] : null;

    let hrvSum = 0;
    let hrvCount = 0;
    let sleepSum = 0;
    let sleepCount = 0;
    for (const w of wellnessData) {
      if (w.hrv != null) {
        hrvSum += w.hrv;
        hrvCount++;
      }
      if (w.sleep_quality != null) {
        sleepSum += w.sleep_quality;
        sleepCount++;
      }
    }

    return {
      ctl: latestFitness?.ctl ?? null,
      atl: latestFitness?.atl ?? null,
      tsb: latestFitness?.form ?? null,
      avgHrv: hrvCount > 0 ? hrvSum / hrvCount : null,
      avgSleepQuality: sleepCount > 0 ? sleepSum / sleepCount : null,
      restingHr: latestWellness?.rhr ?? null,
    };
  } catch (err) {
    console.error("Intervals.icu wellness fetch failed:", err);
    return null;
  }
}
