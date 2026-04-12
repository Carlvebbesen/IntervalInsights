import { getIntervalsApiKey } from "../middlewares/intervals_middleware";
import type { IIntervalsWellnessSummary } from "../types/intervals/IIntervalsWellness";
import { intervalsApiService } from "./intervals_api_service";

export async function fetchWellnessSummary(
  clerkUserId: string,
  oldest: string,
  newest: string
): Promise<IIntervalsWellnessSummary | null> {
  let apiKey: string;
  try {
    apiKey = await getIntervalsApiKey(clerkUserId);
  } catch {
    return null;
  }

  try {
    const [wellnessData, fitnessData] = await Promise.all([
      intervalsApiService.getWellness(apiKey, oldest, newest),
      intervalsApiService.getFitnessModel(apiKey, oldest, newest),
    ]);

    const latestFitness = fitnessData.length > 0
      ? fitnessData[fitnessData.length - 1]
      : null;

    const wellnessWithHrv = wellnessData.filter((w) => w.hrv != null);
    const wellnessWithSleep = wellnessData.filter((w) => w.sleep_quality != null);
    const latestWellness = wellnessData.length > 0
      ? wellnessData[wellnessData.length - 1]
      : null;

    return {
      ctl: latestFitness?.ctl ?? null,
      atl: latestFitness?.atl ?? null,
      tsb: latestFitness?.form ?? null,
      avgHrv: wellnessWithHrv.length > 0
        ? wellnessWithHrv.reduce((sum, w) => sum + (w.hrv ?? 0), 0) / wellnessWithHrv.length
        : null,
      avgSleepQuality: wellnessWithSleep.length > 0
        ? wellnessWithSleep.reduce((sum, w) => sum + (w.sleep_quality ?? 0), 0) / wellnessWithSleep.length
        : null,
      restingHr: latestWellness?.rhr ?? null,
    };
  } catch {
    return null;
  }
}
