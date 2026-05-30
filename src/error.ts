/**
 * Generic application error for expected failure cases (validation, not-found,
 * forbidden, etc.). Thrown from controllers/services and surfaced by `app.onError`
 * with the given status and message — so routers don't need their own try/catch
 * just to produce a JSON error response.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class StravaError extends Error {
  constructor(
    public status: number,
    public details: unknown,
  ) {
    super("Strava API Error");
    this.name = "StravaError";
  }
}

export class IntervalsError extends Error {
  constructor(
    public status: number,
    public details: unknown,
  ) {
    super("Intervals.icu API Error");
    this.name = "IntervalsError";
  }
}
