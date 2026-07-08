import { IntervalsError } from "../error";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";

export type IntervalsTokenResult<T> = { status: "ok"; data: T } | { status: "not_linked" };

/**
 * Runs `fn` with a fresh intervals.icu access token; a 401/403 from token
 * resolution (account not linked / session dead) becomes `not_linked` instead
 * of throwing. Errors from `fn` itself propagate untouched.
 */
export async function withIntervalsToken<T>(
  userId: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<IntervalsTokenResult<T>> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(userId);
  } catch (err) {
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      return { status: "not_linked" };
    }
    throw err;
  }
  return { status: "ok", data: await fn(accessToken) };
}
