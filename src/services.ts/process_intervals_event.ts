import { logger } from "../logger";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import { handleIntervalsScopeChange, linkFromIntervalsActivity } from "./intervals_link_service";

export async function processIntervalsWebhook(
  body: IIntervalsWebhookEvent,
  context: IGlobalBindings,
) {
  const log = logger.child({ fn: "processIntervalsWebhook", event: body.event });
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.intervalsAthleteId, body.athlete_id),
    columns: { id: true, clerkId: true },
  });

  if (!user) {
    log.info({ athleteId: body.athlete_id }, "No user found for Intervals.icu athlete");
    return;
  }

  if (body.event === "ACTIVITY_UPLOADED" || body.event === "ACTIVITY_ANALYZED") {
    const result = await linkFromIntervalsActivity(context, user, body.activity_id);
    if (!result) {
      log.info(
        { intervalsActivityId: body.activity_id },
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
    return;
  }

  if (body.event === "APP_SCOPE_CHANGED") {
    const outcome = await handleIntervalsScopeChange(context, user);
    log.info({ clerkUserId: user.clerkId, outcome }, "APP_SCOPE_CHANGED");
    return;
  }

  log.info("Ignoring Intervals.icu event");
}
