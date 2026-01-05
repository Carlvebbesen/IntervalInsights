import { WorkoutAnalysisOutput } from "../agent/initial_analysis_agent";
import { TrainingType } from "../schema";
import { LLMActivitySummary } from "../types/LLMActivitySummary";
import { ActivityDataPoint, StreamSet } from "../types/strava/IStream";

export function shouldAnalyze(sportType: string): boolean {
  const runningTypes = ["Run", "TrailRun", "VirtualRun", "Elliptical", "Hike", "Ride", "Virtual Ride", "Rowing","Nordic Ski", "Backcountry Ski"];
  return runningTypes.includes(sportType);
}
export function needCompleteAnalysis(trainingType: TrainingType): boolean {
  const trainingTypes =[
  'SHORT_INTERVALS',
  'HILL_SPRINTS',
  'LONG_INTERVALS',
  'SPRINTS',
  'FARTLEK',
  'PROGRESSIVE_LONG_RUN'];
  return trainingTypes.includes(trainingType);
}

export const couldSkipCompleteAnalysis = (result: WorkoutAnalysisOutput)=>{
  const running = ['LONG_RUN',
  'EASY_RUN',
  "NORMAL_RUN",]
  return result.confidence_score > 0.94 && running.includes(result.training_type);
}



export function normalizeActivityStreams(
  timeStream: number[],
  velocityStream?: number[],
  heartrateStream?: number[],
  distanceStream?: number[],
  movingStream?: boolean[]
): ActivityDataPoint[] {
  return timeStream.map((t, index) => {
    return {
      time: t,
      velocity: velocityStream?.[index] ?? 0,
      heartrate: heartrateStream?.[index] ?? 0,
      distance: distanceStream?.[index] ?? 0,
      moving: movingStream?.[index] ?? false,
    };
  });
}

export function prepareDataForLLM(
  data: ActivityDataPoint[],
  bucketSizeSeconds = 30
): LLMActivitySummary {
  const buckets = [];
  const hrValues = data.map((d) => d.heartrate).filter((h) => h > 0);
  const startTime = data[0]?.time ?? 0;
  for (
    let t = 0;
    t < data[data.length - 1].time - startTime;
    t += bucketSizeSeconds
  ) {
    const chunk = data.filter(
      (d) =>
        d.time >= t + startTime && d.time < t + startTime + bucketSizeSeconds
    );

    if (chunk.length === 0) continue;

    const avgVel = chunk.reduce((s, c) => s + c.velocity, 0) / chunk.length;

    const pace =
      avgVel > 0.5
        ? `${Math.floor(16.666 / avgVel)}:${Math.round(
            ((16.666 / avgVel) % 1) * 60
          )
            .toString()
            .padStart(2, "0")}`
        : "Stopped";

    buckets.push({
      time: `${t}s`,
      pace: pace,
      avgHr: Math.round(
        chunk.reduce((s, c) => s + c.heartrate, 0) / chunk.length
      ),
      isMoving: (chunk.filter((c) => c.moving).length / chunk.length).toFixed(
        2
      ),
    });
  }

  return {
    metadata: {
      totalDistance: data[data.length - 1].distance,
      totalTime: data.length,
      avgHeartRate: hrValues.reduce((a, b) => a + b, 0) / hrValues.length,
      maxVelocity: Math.max(...data.map((d) => d.velocity)),
      hrStandardDeviation: calculateSD(hrValues),
    },
    buckets,
  };
}

function calculateSD(array: number[]) {
  const n = array.length;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n
  );
}
export function parsePaceStringToMetersPerSecond(paceStr: string | null): number | null {
  if (!paceStr) return null;

  const clean = paceStr.replace(/[^\d:.]/g, ''); 
  
  let paceInMinPerKm: number;

  if (clean.includes(':')) {
    const parts = clean.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    paceInMinPerKm = parts[0] + (parts[1] / 60);
  } else {
    paceInMinPerKm = parseFloat(clean);
  }

  if (!paceInMinPerKm || paceInMinPerKm === 0) return null;
  return 1000 / (paceInMinPerKm * 60);
}
export const formatRawPaceFromMps = (mps: number): string => {
  if (mps <= 0) return "-:--";

  const minPerKm = (1000 / mps) / 60;
  let mins = Math.floor(minPerKm);
  let secs = Math.round((minPerKm - mins) * 60);
  if (secs === 60) {
    mins++;
    secs = 0;
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
export function calculateSegmentStats(
  streamSet: Required<Pick<StreamSet, "time" | "distance" | "heartrate">>,
  startTime: number,
  endTime: number
) {
  const startIdx = streamSet.time.data.findIndex((t) => t >= startTime);
  let endIdx = streamSet.time.data.findIndex((t) => t >= endTime);

  if (endIdx === -1) endIdx = streamSet.time.data.length - 1;
  if (startIdx === -1 || startIdx >= endIdx) return null;

  const distSlice = streamSet.distance.data.slice(startIdx, endIdx + 1);
  const timeSlice = streamSet.time.data.slice(startIdx, endIdx + 1);
  const hrSlice = streamSet.heartrate.data.slice(startIdx, endIdx + 1);

  const duration = timeSlice[timeSlice.length - 1] - timeSlice[0];
  const distance = distSlice[distSlice.length - 1] - distSlice[0];

  const avgSpeedMps = duration > 0 ? distance / duration : 0;
  const sortedHr = [...hrSlice].sort((a, b) => a - b);
  const mid = Math.floor(sortedHr.length / 2);
  
  const medianHr = sortedHr.length === 0 
    ? 0 
    : sortedHr.length % 2 !== 0
      ? sortedHr[mid]
      : (sortedHr[mid - 1] + sortedHr[mid]) / 2;

  return {
    actualDuration: duration,
    actualDistance: distance,
    actualPace: avgSpeedMps,
    avgHeartRate: Math.round(
      hrSlice.reduce((a, b) => a + b, 0) / hrSlice.length
    ),
    maxHeartRate: Math.max(...hrSlice),
    medianHeartRate: Math.round(medianHr),
    timeSeriesEndTime: streamSet.time.data[endIdx],
  };
}