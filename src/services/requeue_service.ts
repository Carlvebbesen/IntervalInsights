import { sql } from "drizzle-orm";
import { runInBackground } from "../background";
import { logger } from "../logger";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { startAnalysis } from "./analysis_service";

const REQUEUE_BATCH_LIMIT = 100;
const ERROR_RETRY_CAP = 2;
const ORPHAN_TIMEOUT_MINUTES = 10;
const REQUEUE_MIN_INTERVAL_MS = 30_000;
const THROTTLE_SWEEP_THRESHOLD = 1_000;

// Throttle the requeue write per user: this runs on the (frequently polled)
// pending GET, but stale-activity recovery is best-effort and not time-critical,
// so at most once per REQUEUE_MIN_INTERVAL_MS keeps GETs from writing every call.
const lastRequeueByUser = new Map<string, number>();

export async function requeueStaleActivities(
  db: IGlobalBindings["db"],
  userId: string,
  stravaAccessToken: string,
): Promise<void> {
  const now = Date.now();
  const last = lastRequeueByUser.get(userId);
  if (last !== undefined && now - last < REQUEUE_MIN_INTERVAL_MS) return;
  if (lastRequeueByUser.size >= THROTTLE_SWEEP_THRESHOLD) {
    for (const [key, ts] of lastRequeueByUser) {
      if (now - ts >= REQUEUE_MIN_INTERVAL_MS) lastRequeueByUser.delete(key);
    }
  }
  lastRequeueByUser.set(userId, now);

  const tag = `[requeueStaleActivities user=${userId}]`;
  // Orphan detection keys on analysis_started_at (stamped on every ongoing_*
  // transition). created_at is the INGEST time and analyzed_at the INITIAL
  // phase time — using those here re-queued perfectly healthy in-flight runs
  // whenever the row was older than the timeout, restarting them mid-flight.
  const requeued = await db
    .update(activities)
    .set({
      analysisStatus: "pending",
      analysisAttemptCount: sql`${activities.analysisAttemptCount} + 1`,
    })
    .where(
      sql`${activities.id} IN (
        SELECT id FROM ${activities}
        WHERE user_id = ${userId}
          AND (
            analysis_status = 'skipped_inactive'
            OR (analysis_status = 'error' AND analysis_attempt_count < ${ERROR_RETRY_CAP})
            OR (
              analysis_status = 'ongoing_init'
              AND COALESCE(analysis_started_at, created_at) < NOW() - INTERVAL '${sql.raw(String(ORPHAN_TIMEOUT_MINUTES))} minutes'
              AND analysis_attempt_count < ${ERROR_RETRY_CAP}
            )
            OR (
              analysis_status = 'ongoing_completed'
              AND COALESCE(analysis_started_at, analyzed_at, created_at) < NOW() - INTERVAL '${sql.raw(String(ORPHAN_TIMEOUT_MINUTES))} minutes'
              AND analysis_attempt_count < ${ERROR_RETRY_CAP}
            )
          )
        LIMIT ${REQUEUE_BATCH_LIMIT}
      )`,
    )
    .returning({ id: activities.id, stravaActivityId: activities.stravaActivityId });

  if (requeued.length > 0) {
    logger.info({ userId, tag, count: requeued.length }, "re-queued stale activities");
  }

  for (const row of requeued) {
    // Restart by internal id: intervals.icu-only rows (stravaActivityId null)
    // are fetchable too — addressing by Strava id stranded them in `pending`.
    runInBackground(
      "analysis.restart",
      () => startAnalysis(db, stravaAccessToken, row.id, row.stravaActivityId, userId),
      {
        attributes: {
          "activity.id": row.id,
          "strava.activity_id": row.stravaActivityId ?? "",
          "user.id": userId,
        },
      },
    );
  }
}
