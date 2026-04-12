export class StravaError extends Error {
  constructor(public status: number, public details: any) {
    super("Strava API Error");
    this.name = "StravaError";
  }
}

export class IntervalsError extends Error {
  constructor(public status: number, public details: any) {
    super("Intervals.icu API Error");
    this.name = "IntervalsError";
  }
}