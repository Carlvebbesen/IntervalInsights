export interface LLMActivitySummary {
  metadata: {
    totalDistance: number;
    totalTime: number;
    avgHeartRate: number | null;
    maxVelocity: number;
    hrStandardDeviation: number | null;
  };
  buckets: {
    time: string;
    pace: string;
    avgHr: number | null;
    isMoving: string;
  }[];
}
