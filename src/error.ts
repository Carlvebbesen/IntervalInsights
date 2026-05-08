export class StravaError extends Error {
  constructor(
    public status: number,
    public details: unknown,
  ) {
    super("Strava API Error");
    this.name = "StravaError";
  }
}
