export interface IIntervalsWellness {
  id: string; // ISO-8601 date (e.g. "2026-04-12")
  fatigue: number | null;
  motivation: number | null;
  soreness: number | null;
  sleep_duration: number | null;
  sleep_quality: number | null;
  rhr: number | null;
  hrv: number | null;
  weight: number | null;
  notes: string | null;
}

export interface IIntervalsFitnessEvent {
  id: string;
  start_date_local: string;
  fitness: number | null; // CTL
  fatigue: number | null; // ATL
  form: number | null;    // TSB
  ctl: number | null;
  atl: number | null;
  rampRate: number | null;
}

export interface IIntervalsWellnessSummary {
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  avgHrv: number | null;
  avgSleepQuality: number | null;
  restingHr: number | null;
}
