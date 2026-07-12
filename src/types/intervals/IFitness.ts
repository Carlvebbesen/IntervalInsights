export type HrvStatus = "balanced" | "unbalanced" | "low" | null;

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
  hrv: number | null;
  hrv7dAvg: number | null;
  hrvStatus: HrvStatus;
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
