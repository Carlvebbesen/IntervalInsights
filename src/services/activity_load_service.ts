import { and, eq } from "drizzle-orm";
import { logger } from "../logger";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { getStreamSet } from "./activity_source_service";
import { resolveThresholds } from "./threshold_service";
import {
  type ActivityThresholds,
  computeActivityLoad,
  type LoadStreams,
} from "./training_load_service";

type Db = IGlobalBindings["db"];

const LOAD_STREAM_KEYS = [
  "time",
  "velocity_smooth",
  "heartrate",
  "distance",
  "moving",
  "altitude",
  "watts",
] as const;

async function fetchLoadStreams(
  db: Db,
  userId: string,
  activityId: number,
): Promise<LoadStreams | null> {
  try {
    const s = await getStreamSet(db, userId, activityId, LOAD_STREAM_KEYS);
    return {
      time: s.time?.data ?? [],
      velocity: s.velocity_smooth?.data ?? null,
      altitude: s.altitude?.data ?? null,
      distance: s.distance?.data ?? null,
      heartrate: s.heartrate?.data ?? null,
      watts: s.watts?.data ?? null,
      moving: s.moving?.data ?? null,
    };
  } catch (err) {
    logger.warn({ err, userId, activityId }, "activity load: stream fetch failed");
    return null;
  }
}

/**
 * Resolve thresholds, fetch streams, and self-compute the activity's training
 * load, persisting `trainingLoad` + `trainingLoadSource`. A null result or a
 * stream-fetch failure leaves any existing value untouched — a transient
 * failure must never wipe a previously computed load. Never throws; called from
 * webhook ingest paths that must not break.
 */
export async function computeAndStoreActivityLoad(
  db: Db,
  userId: string,
  activityId: number,
): Promise<{ load: number; source: string } | null> {
  const thresholds = await resolveThresholds(db, userId);
  return computeAndStoreActivityLoadWithThresholds(db, userId, activityId, thresholds);
}

/**
 * The per-activity load step with thresholds injected instead of resolved — the
 * one code path shared by the ingest wrapper (above) and the historical backfill
 * script, which resolves thresholds as-of each activity's date. Same never-wipe
 * invariant: a null result or stream-fetch failure returns null WITHOUT writing.
 * `dryRun` computes and returns the result but skips the write (backfill preview).
 */
export async function computeAndStoreActivityLoadWithThresholds(
  db: Db,
  userId: string,
  activityId: number,
  thresholds: ActivityThresholds,
  opts: { dryRun?: boolean } = {},
): Promise<{ load: number; source: string } | null> {
  try {
    const row = await db.query.activities.findFirst({
      where: and(eq(activities.id, activityId), eq(activities.userId, userId)),
      columns: { id: true, sportType: true },
    });
    if (!row) return null;

    const streams = await fetchLoadStreams(db, userId, activityId);
    if (!streams || streams.time.length === 0) return null;

    const result = computeActivityLoad({ sportType: row.sportType, streams, thresholds });
    if (!result) return null;

    if (!opts.dryRun) {
      await db
        .update(activities)
        .set({ trainingLoad: result.load, trainingLoadSource: result.source })
        .where(and(eq(activities.id, activityId), eq(activities.userId, userId)));
    }

    return { load: result.load, source: result.source };
  } catch (err) {
    logger.error({ err, userId, activityId }, "activity load: unexpected failure");
    return null;
  }
}
