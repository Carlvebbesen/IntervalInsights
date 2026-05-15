export interface IIntervalsWellness {
  id: string;
  ctl: number | null;
  atl: number | null;
  rampRate: number | null;
  ctlLoad: number | null;
  atlLoad: number | null;
  sleepSecs: number | null;
  sleepScore: number | null;
  sleepQuality: number | null;
  restingHR: number | null;
  hrv: number | null;
  readiness: number | null;
  baevskySI: number | null;
  spO2: number | null;
  respiration: number | null;
  weight: number | null;
  bodyFat: number | null;
  vo2max: number | null;
  soreness: number | null;
  fatigue: number | null;
  stress: number | null;
  mood: number | null;
  motivation: number | null;
  injury: number | null;
  sickness: number | null;
  comments: string | null;
}

export interface IIntervalsWellnessSummary {
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  avgHrv: number | null;
  avgSleepQuality: number | null;
  restingHr: number | null;
}

export interface IIntervalsTrainingSummary {
  date: string;
  fitness: {
    ctl: number | null;
    atl: number | null;
    rampRate: number | null;
    ctlLoad: number | null;
    atlLoad: number | null;
  };
  sleep: {
    sleepSecs: number | null;
    sleepScore: number | null;
  };
  recovery: {
    restingHR: number | null;
    hrv: number | null;
    readiness: number | null;
    baevskySI: number | null;
    spO2: number | null;
    respiration: number | null;
  };
  body: {
    weight: number | null;
    vo2max: number | null;
  };
}

export type IIntervalsTrainingSummaryResult =
  | { status: "ok"; data: IIntervalsTrainingSummary }
  | { status: "not_linked"; data: null }
  | { status: "no_recent_data"; data: null };

export type NumericMetric =
  | "ctl"
  | "atl"
  | "tsb"
  | "rampRate"
  | "ctlLoad"
  | "atlLoad"
  | "sleepSecs"
  | "sleepScore"
  | "sleepQuality"
  | "restingHR"
  | "hrv"
  | "readiness"
  | "baevskySI"
  | "spO2"
  | "respiration"
  | "soreness"
  | "fatigue"
  | "stress"
  | "mood"
  | "motivation"
  | "injury"
  | "sickness"
  | "weight"
  | "bodyFat"
  | "vo2max";

export interface IIntervalsWellnessPoint {
  date: string;
  fitness: {
    ctl: number | null;
    atl: number | null;
    tsb: number | null;
    rampRate: number | null;
    ctlLoad: number | null;
    atlLoad: number | null;
  };
  sleep: {
    sleepSecs: number | null;
    sleepScore: number | null;
    sleepQuality: number | null;
  };
  recovery: {
    restingHR: number | null;
    hrv: number | null;
    readiness: number | null;
    baevskySI: number | null;
    spO2: number | null;
    respiration: number | null;
  };
  subjective: {
    soreness: number | null;
    fatigue: number | null;
    stress: number | null;
    mood: number | null;
    motivation: number | null;
  };
  health: {
    injury: number | null;
    sickness: number | null;
  };
  body: {
    weight: number | null;
    bodyFat: number | null;
    vo2max: number | null;
  };
  comments: string | null;
}

export interface IIntervalsMetricStats {
  latest: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface IIntervalsWellnessSeries {
  range: { oldest: string; newest: string };
  metricsAvailable: NumericMetric[];
  summary: Record<NumericMetric, IIntervalsMetricStats>;
  points: IIntervalsWellnessPoint[];
}

export type IIntervalsWellnessSeriesResult =
  | { status: "ok"; data: IIntervalsWellnessSeries }
  | { status: "not_linked"; data: null }
  | { status: "no_data"; data: null };

export interface IIntervalsWeekWellness {
  avgSleepScore: number | null;
  avgFatigue: number | null;
  fitness: number | null;
  form: number | null;
  totalLoad: number | null;
}
