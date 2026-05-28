/**
 * Flat fitness-view contract consumed by the interval-insights "fitness" screen.
 * Distinct from the grouped `IIntervalsWellnessPoint` — this is a chart-friendly
 * shape with a derived `hrvStatus` (computed here, not provided by intervals.icu).
 */

/**
 * Per-day HRV status. The fitness series only emits `balanced` / `unbalanced`
 * (Garmin's daily-dot semantics: the 7-day average is inside vs outside the
 * baseline band). `low` is kept for forward-compatibility with a possible
 * headline status and is not emitted per-day. `null` = insufficient history.
 */
export type HrvStatus = "balanced" | "unbalanced" | "low" | null;

/**
 * The personal HRV baseline range for a given day (Garmin's "balanced" zone),
 * for shading a band behind the HRV line. `lowerBalanced`/`upperBalanced` bound
 * the balanced zone (baseline mean ± 1 SD); `mean` is the center line.
 */
export interface IHrvBaseline {
  mean: number;
  lowerBalanced: number;
  upperBalanced: number;
}

export interface IFitnessPoint {
  date: string;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  ctlLoad: number | null;
  atlLoad: number | null;
  hrv: number | null; // raw nightly HRV reading (plot as faint dots)
  hrv7dAvg: number | null; // 7-day rolling average — the smooth line Garmin plots
  // Status of the 7-day average vs the band (Garmin's official per-day status).
  // Color the smooth `hrv7dAvg` line with this.
  hrvStatus: HrvStatus;
  // Status of the raw nightly `hrv` vs the same band. Color the raw nightly dots
  // with this so individual nights outside the band stand out. Null when there's
  // no nightly reading or no baseline yet.
  hrvNightlyStatus: HrvStatus;
  hrvBaseline: IHrvBaseline | null;
  sleepScore: number | null;
}

export interface IFitnessSeries {
  range: { oldest: string; newest: string };
  points: IFitnessPoint[];
}

export type IFitnessSeriesResult =
  | { status: "ok"; data: IFitnessSeries }
  | { status: "not_linked"; data: null }
  | { status: "no_data"; data: null };
