import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import { handleIntervalsScopeChange, linkFromIntervalsActivity } from "./intervals_link_service";

export async function processIntervalsWebhook(
  body: IIntervalsWebhookEvent,
  context: IGlobalBindings,
) {
  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.intervalsAthleteId, body.athlete_id),
    columns: { id: true, clerkId: true },
  });

  if (!user) {
    console.log(`No user found for Intervals.icu athlete: ${body.athlete_id}`);
    return;
  }

  if (body.event === "ACTIVITY_UPLOADED" || body.event === "ACTIVITY_ANALYZED") {
    const result = await linkFromIntervalsActivity(context, user, body.activity_id);
    if (!result) {
      console.log(
        `No matching local activity for Intervals.icu activity ${body.activity_id} (event: ${body.event})`,
      );
      return;
    }
    console.log(
      `Linked Intervals.icu activity ${result.intervalsActivityId} to activity ${result.localActivityId} (event: ${body.event})`,
    );
    return;
  }

  if (body.event === "APP_SCOPE_CHANGED") {
    const outcome = await handleIntervalsScopeChange(context, user);
    console.log(`APP_SCOPE_CHANGED for ${user.clerkId}: ${outcome}`);
    return;
  }

  console.log(`Ignoring Intervals.icu event: ${body.event}`);
}
