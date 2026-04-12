import { eq } from "drizzle-orm";
import { activities, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import { getIntervalsApiKey } from "../middlewares/intervals_middleware";
import { intervalsApiService } from "./intervals_api_service";

export async function processIntervalsWebhook(
  body: IIntervalsWebhookEvent,
  context: IGlobalBindings
) {
  if (body.event !== "ACTIVITY_ANALYZED") {
    console.log(`Ignoring Intervals.icu event: ${body.event}`);
    return;
  }

  const user = await context.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.intervalsAthleteId, body.athlete_id),
  });

  if (!user) {
    console.log(`No user found for Intervals.icu athlete: ${body.athlete_id}`);
    return;
  }

  let apiKey: string;
  try {
    apiKey = await getIntervalsApiKey(user.clerkId);
  } catch {
    console.log(`No Intervals.icu API key for user: ${user.clerkId}`);
    return;
  }

  // Fetch the Intervals.icu activity to find the linked Strava activity ID
  const intervalsActivity = await intervalsApiService.getActivity(apiKey, body.activity_id);

  // Intervals.icu activities synced from Strava carry a numeric strava_id
  const stravaId = intervalsActivity.strava_id;

  if (stravaId == null) {
    console.log(`Intervals.icu activity ${body.activity_id} has no Strava link, skipping`);
    return;
  }

  // Find the matching activity in our DB
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq }) => eq(a.stravaActivityId, stravaId),
  });

  if (!activity) {
    // Strava webhook hasn't created the activity yet (rare), skip
    console.log(`No activity found for Strava ID ${stravaId}, Intervals.icu webhook arrived first`);
    return;
  }

  // Link the Intervals.icu activity ID and mark as analyzed
  await context.db
    .update(activities)
    .set({
      intervalsIcuId: body.activity_id,
      intervalsAnalyzed: true,
    })
    .where(eq(activities.id, activity.id));

  console.log(
    `Linked Intervals.icu activity ${body.activity_id} to activity ${activity.id} (Strava ID: ${stravaId})`
  );
}
