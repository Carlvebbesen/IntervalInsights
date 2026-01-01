export interface LLMActivitySummary {
  metadata: {
    totalDistance: number;
    totalTime: number;
    avgHeartRate: number;
    maxVelocity: number;
    hrStandardDeviation: number;
  };
  buckets: {
    time: string;
    pace: string;
    avgHr: number;
    isMoving: string;
  }[];
}