import { runInBackground } from "../background";
import { config } from "../config";
import type { Logger } from "../logger";
import { processIntervalsWebhook } from "../services/process_intervals_event";
import { processStravaWebhook } from "../services/process_strava_event";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookPayload } from "../types/intervals/IIntervalsWebhookEvent";
import type { IStravaWebhookEvent } from "../types/strava/IWebHookEvent";

export function verifyStravaHandshake(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
  logger: Logger,
): string | undefined | null {
  const expectedToken = config.STRAVA_WEBHOOK_VERIFY_TOKEN;
  logger.info(
    { mode, tokenMatch: token === expectedToken, challenge },
    "Strava handshake triggered",
  );
  if (mode === "subscribe" && token === expectedToken) {
    return challenge;
  }
  logger.error("Strava handshake verification failed: token mismatch or invalid mode");
  return null;
}

export function handleStravaWebhook(
  body: IStravaWebhookEvent,
  env: IGlobalBindings,
  logger: Logger,
): boolean {
  logger.info(
    { aspectType: body.aspect_type, eventId: body.object_id, athleteId: body.owner_id },
    "Strava event received",
  );
  if (body.subscription_id?.toString() !== config.STRAVA_SUBSCRIPTION_ID) {
    return false;
  }
  runInBackground("strava.webhook.process", () => processStravaWebhook(body, env), {
    attributes: {
      "strava.aspect_type": body.aspect_type,
      "strava.object_id": body.object_id,
      "strava.owner_id": body.owner_id,
    },
    logger,
  });
  return true;
}

export function handleIntervalsWebhook(
  body: IIntervalsWebhookPayload,
  env: IGlobalBindings,
  logger: Logger,
): boolean {
  if (body.secret !== config.INTERVALS_WEBHOOK_SECRET) {
    logger.warn(
      { eventCount: body.events.length },
      "Rejected intervals.icu webhook with bad secret",
    );
    return false;
  }

  for (const event of body.events) {
    const activity = (event as { activity?: { id: string | number } }).activity;
    const activityId = activity ? String(activity.id) : undefined;

    logger.info(
      { type: event.type, athleteId: event.athlete_id, activityId },
      "Intervals.icu event received",
    );

    runInBackground("intervals.webhook.process", () => processIntervalsWebhook(event, env), {
      attributes: {
        "intervals.event": event.type,
        "intervals.athlete_id": event.athlete_id,
        "intervals.activity_id": activityId,
      },
      logger,
    });
  }

  return true;
}
