import { createClerkClient } from "@clerk/backend";
import { env } from "bun";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { IntervalsError } from "../error";
import { logger } from "../logger";
import { getIntervalsAccessToken } from "../middlewares/intervals_middleware";
import { activities, users } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import type { IIntervalsActivity } from "../types/intervals/IIntervalsActivity";
import { intervalsApiService } from "./intervals_api_service";

const TIME_TOLERANCE_MS = 5 * 60 * 1000;
const DISTANCE_TOLERANCE_RATIO = 0.03;
const LIST_WINDOW_MS = 60 * 60 * 1000;

export interface LinkResult {
  localActivityId: number;
  intervalsActivityId: string;
}

function matchesByDistanceAndTime(
  intervalsStartMs: number,
  intervalsDistance: number,
  localStartMs: number,
  localDistance: number,
): boolean {
  const timeDelta = Math.abs(intervalsStartMs - localStartMs);
  if (timeDelta > TIME_TOLERANCE_MS) return false;

  const minDistance = intervalsDistance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = intervalsDistance * (1 + DISTANCE_TOLERANCE_RATIO);
  return localDistance >= minDistance && localDistance <= maxDistance;
}

async function findLocalByFuzzyMatch(
  context: IGlobalBindings,
  userId: string,
  intervalsActivity: IIntervalsActivity,
): Promise<{ id: number } | null> {
  const startTime = new Date(intervalsActivity.local_start_time);
  if (Number.isNaN(startTime.getTime())) return null;

  const minTime = new Date(startTime.getTime() - TIME_TOLERANCE_MS);
  const maxTime = new Date(startTime.getTime() + TIME_TOLERANCE_MS);

  const minDistance = intervalsActivity.distance * (1 - DISTANCE_TOLERANCE_RATIO);
  const maxDistance = intervalsActivity.distance * (1 + DISTANCE_TOLERANCE_RATIO);

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
        lte(activities.distance, maxDistance),
      ),
    );

  if (candidates.length !== 1) return null;
  return candidates[0];
}

async function commitLink(
  context: IGlobalBindings,
  localActivityId: number,
  intervalsActivityId: string,
): Promise<void> {
  await context.db
    .update(activities)
    .set({
      intervalsIcuId: intervalsActivityId,
      intervalsAnalyzed: true,
    })
    .where(and(eq(activities.id, localActivityId), isNull(activities.intervalsIcuId)));
}

export async function linkFromIntervalsActivity(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
  intervalsActivityId: string,
): Promise<LinkResult | null> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return null;
  }

  const intervalsActivity = await intervalsApiService.getActivity(accessToken, intervalsActivityId);

  const match = await findLocalByFuzzyMatch(context, user.id, intervalsActivity);
  if (!match) return null;

  await commitLink(context, match.id, intervalsActivityId);
  return { localActivityId: match.id, intervalsActivityId };
}

export async function linkFromLocalActivity(
  context: IGlobalBindings,
  user: { id: string; clerkId: string },
  localActivityId: number,
): Promise<LinkResult | null> {
  const activity = await context.db.query.activities.findFirst({
    where: (a, { eq, and }) => and(eq(a.id, localActivityId), eq(a.userId, user.id)),
    columns: {
      id: true,
      startDateLocal: true,
      distance: true,
      intervalsIcuId: true,
    },
  });
  if (!activity || activity.intervalsIcuId) return null;

  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return null;
  }

  const localStartMs = activity.startDateLocal.getTime();
  const oldest = new Date(localStartMs - LIST_WINDOW_MS).toISOString().slice(0, 10);
  const newest = new Date(localStartMs + LIST_WINDOW_MS).toISOString().slice(0, 10);

  let candidates: IIntervalsActivity[];
  try {
    candidates = await intervalsApiService.listActivities(accessToken, oldest, newest);
  } catch (err) {
    logger.error({ err }, "intervals.icu listActivities failed");
    return null;
  }

  const fuzzy = candidates.filter((candidate) => {
    const candidateStart = new Date(candidate.local_start_time).getTime();
    if (Number.isNaN(candidateStart)) return false;
    return matchesByDistanceAndTime(
      candidateStart,
      candidate.distance,
      localStartMs,
      activity.distance,
    );
  });
  if (fuzzy.length !== 1) return null;

  await commitLink(context, activity.id, fuzzy[0].id);
  return { localActivityId: activity.id, intervalsActivityId: fuzzy[0].id };
}

export async function disconnectIntervals(
  context: IGlobalBindings,
  clerkUserId: string,
): Promise<void> {
  const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  await clerkClient.users.updateUserMetadata(clerkUserId, {
    privateMetadata: { intervals: null },
    publicMetadata: { intervals_connected: false },
  });
  await context.db
    .update(users)
    .set({ intervalsAthleteId: null })
    .where(eq(users.clerkId, clerkUserId));
}

export async function handleIntervalsScopeChange(
  context: IGlobalBindings,
  user: { clerkId: string },
): Promise<"disconnected" | "still_valid" | "already_disconnected"> {
  let accessToken: string;
  try {
    accessToken = await getIntervalsAccessToken(user.clerkId);
  } catch {
    return "already_disconnected";
  }

  try {
    await intervalsApiService.getAthlete(accessToken);
    return "still_valid";
  } catch (err) {
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      await disconnectIntervals(context, user.clerkId);
      return "disconnected";
    }
    throw err;
  }
}
