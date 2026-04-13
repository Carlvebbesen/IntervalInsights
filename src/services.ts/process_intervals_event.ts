import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsActivity } from "../types/intervals/IIntervalsActivity";
import type { IIntervalsWebhookEvent } from "../types/intervals/IIntervalsWebhookEvent";
import { getIntervalsApiKey } from "../middlewares/intervals_middleware";
import { intervalsApiService } from "./intervals_api_service";

// Fuzzy match tolerances for activities not linked to Strava
const TIME_TOLERANCE_MS = 2 * 60 * 1000; // ±2 minutes
const DISTANCE_TOLERANCE_RATIO = 0.01; // ±1%

interface MatchedActivity {
  id: number;
  matchType: "strava_id" | "fuzzy";
}

async function findActivityByStravaId(
  context: IGlobalBindings,
  userId: string,
  stravaId: number
): Promise<MatchedActivity | null> {
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) =>
      and(eq(a.stravaActivityId, stravaId), eq(a.userId, userId)),
  });
  return activity ? { id: activity.id, matchType: "strava_id" } : null;
}

async function findActivityByFuzzyMatch(
  context: IGlobalBindings,
  userId: string,
  intervalsActivity: IIntervalsActivity
): Promise<MatchedActivity | null> {
  const startTime = new Date(intervalsActivity.local_start_time);
  if (isNaN(startTime.getTime())) return null;

  const minTime = new Date(startTime.getTime() - TIME_TOLERANCE_MS);
  const maxTime = new Date(startTime.getTime() + TIME_TOLERANCE_MS);

  const minDistance = intervalsActivity.distance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = intervalsActivity.distance * (1 + DISTANCE_TOLERANCE_RATIO);

  // Only match unlinked activities to avoid stealing a previously matched one
  const candidates = await context.db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNull(activities.intervalsIcuId),
        gte(activities.startDateLocal, minTime),
        lte(activities.startDateLocal, maxTime),
        gte(activities.distance, minDistance),
        lte(activities.distance, maxDistance)
      )
    );

  // Only commit to a match if it's unambiguous
  if (candidates.length !== 1) return null;
  return { id: candidates[0].id, matchType: "fuzzy" };
}

async function findMatchingActivity(
  context: IGlobalBindings,
  userId: string,
  intervalsActivity: IIntervalsActivity
): Promise<MatchedActivity | null> {
  if (intervalsActivity.strava_id != null) {
    const stravaMatch = await findActivityByStravaId(
      context,
      userId,
      intervalsActivity.strava_id
    );
    if (stravaMatch) return stravaMatch;
  }
  return findActivityByFuzzyMatch(context, userId, intervalsActivity);
}

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

  const intervalsActivity = await intervalsApiService.getActivity(apiKey, body.activity_id);

  const match = await findMatchingActivity(context, user.id, intervalsActivity);

  if (!match) {
    console.log(
      `No matching activity for Intervals.icu activity ${body.activity_id} (strava_id: ${intervalsActivity.strava_id ?? "none"}), skipping`
    );
    return;
  }

  await context.db
    .update(activities)
    .set({
      intervalsIcuId: body.activity_id,
      intervalsAnalyzed: true,
    })
    .where(eq(activities.id, match.id));

  console.log(
    `Linked Intervals.icu activity ${body.activity_id} to activity ${match.id} (match: ${match.matchType})`
  );
}
