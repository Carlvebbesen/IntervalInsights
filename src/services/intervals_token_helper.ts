import { IntervalsError } from "../error";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";

export type IntervalsTokenResult<T> = { status: "ok"; data: T } | { status: "not_linked" };

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
