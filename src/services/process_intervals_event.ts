import { logger } from "../logger";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import { handleIntervalsScopeChange, linkFromIntervalsActivity } from "./intervals_link_service";
import { progressService } from "./progress_service";

export async function processIntervalsWebhook(
  event: IIntervalsWebhookEvent,
  context: IGlobalBindings,
) {
  const log = logger.child({ fn: "processIntervalsWebhook", type: event.type });

  if (event.type === "TEST") {
    log.info({ athleteId: event.athlete_id }, "Intervals.icu TEST event acknowledged");
    return;
  }

  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.intervalsAthleteId, event.athlete_id),
    columns: { id: true, clerkId: true },
  });

  if (!user) {
    log.info({ athleteId: event.athlete_id }, "No user found for Intervals.icu athlete");
    return;
  }

  if (event.type === "ACTIVITY_UPLOADED" || event.type === "ACTIVITY_ANALYZED") {
    const activity = (event as { activity?: { id: string | number } }).activity;
    const activityId = activity ? String(activity.id) : undefined;
    if (!activityId) {
      log.info("Activity event missing activity.id, skipping");
      return;
    }
    const result = await linkFromIntervalsActivity(context, user, activityId);
    if (!result) {
      log.info(
        { intervalsActivityId: activityId },
        "No matching local activity for Intervals.icu activity",
      );
      return;
    }
    log.info(
      {
        intervalsActivityId: result.intervalsActivityId,
        localActivityId: result.localActivityId,
      },
      "Linked Intervals.icu activity",
    );
    await progressService.publish(user.id, {
      type: "progress",
      data: {
        id: result.localActivityId,
        kind: "intervals_sync",
        phase: "received",
        message: "intervals.icu activity linked",
      },
    });
    return;
  }

  if (event.type === "APP_SCOPE_CHANGED") {
    const outcome = await handleIntervalsScopeChange(context, user);
    log.info({ clerkUserId: user.clerkId, outcome }, "APP_SCOPE_CHANGED");
    return;
  }

  log.info("Ignoring Intervals.icu event");
}
