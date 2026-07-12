import { config } from "../config";
import type { Logger } from "../logger";

const STRAVA_PUSH_SUBSCRIPTIONS_URL = "https://www.strava.com/api/v3/push_subscriptions";

export type StravaProxyResponse = { status: number; body: unknown };

export async function createPushSubscription(logger: Logger): Promise<StravaProxyResponse> {
  const callbackUrl = `${config.APP_BASE_URL}api/strava/event`;
  logger.info({ callbackUrl }, "Setting up Strava subscription");
  const formData = new FormData();
  formData.append("client_id", config.STRAVA_CLIENT_ID);
  formData.append("client_secret", config.STRAVA_CLIENT_SECRET);
  formData.append("callback_url", callbackUrl);
  formData.append("verify_token", config.STRAVA_WEBHOOK_VERIFY_TOKEN);

  const response = await fetch(STRAVA_PUSH_SUBSCRIPTIONS_URL, {
    method: "POST",
    body: formData,
  });

  const body = await response.json();

  if (response.ok) {
    logger.info({ data: body }, "Subscription request sent successfully");
  } else {
    logger.error({ data: body }, "Subscription request failed");
  }
  return { status: response.status, body };
}

export async function listPushSubscriptions(): Promise<StravaProxyResponse> {
  const url = new URL(STRAVA_PUSH_SUBSCRIPTIONS_URL);
  url.searchParams.append("client_id", config.STRAVA_CLIENT_ID);
  url.searchParams.append("client_secret", config.STRAVA_CLIENT_SECRET);

  const response = await fetch(url.toString(), { method: "GET" });
  return { status: response.status, body: await response.json() };
}

export async function deletePushSubscription(id: string): Promise<StravaProxyResponse> {
  const url = new URL(`${STRAVA_PUSH_SUBSCRIPTIONS_URL}/${id}`);
  url.searchParams.append("client_id", config.STRAVA_CLIENT_ID);
  url.searchParams.append("client_secret", config.STRAVA_CLIENT_SECRET);

  const response = await fetch(url.toString(), { method: "DELETE" });
  if (response.status === 204) {
    return { status: 204, body: null };
  }
  return { status: response.status, body: await response.json() };
}
