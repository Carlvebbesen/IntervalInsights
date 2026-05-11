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
  vo2max: number | null;
}

export interface IIntervalsFitnessEvent {
  id: number;
  start_date_local: string;
  end_date_local: string | null;
  name: string | null;
  category: string | null;
  type: string | null;
  sub_type: string | null;
  icu_ctl: number | null;
  icu_atl: number | null;
  icu_training_load: number | null;
  icu_intensity: number | null;
  icu_ftp: number | null;
  moving_time: number | null;
  distance: number | null;
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
