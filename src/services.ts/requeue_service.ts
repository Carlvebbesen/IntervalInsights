import { sql } from "drizzle-orm";
import { runInBackground } from "../background";
import { logger } from "../logger";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { restartAnalysisByStravaId } from "./analysis_service";

const REQUEUE_BATCH_LIMIT = 100;
const ERROR_RETRY_CAP = 2;
const ORPHAN_TIMEOUT_MINUTES = 10;

export async function requeueStaleActivities(
  db: IGlobalBindings["db"],
  userId: string,
  stravaAccessToken: string,
): Promise<void> {
  const tag = `[requeueStaleActivities user=${userId}]`;
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
              analysis_status IN ('pending', 'ongoing_init')
              AND created_at < NOW() - INTERVAL '${sql.raw(String(ORPHAN_TIMEOUT_MINUTES))} minutes'
              AND analysis_attempt_count < ${ERROR_RETRY_CAP}
            )
            OR (
              analysis_status = 'ongoing_completed'
              AND COALESCE(analyzed_at, created_at) < NOW() - INTERVAL '${sql.raw(String(ORPHAN_TIMEOUT_MINUTES))} minutes'
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
    runInBackground(
      "analysis.restart",
      () => restartAnalysisByStravaId(db, stravaAccessToken, row.stravaActivityId, userId),
      {
        attributes: {
          "activity.id": row.id,
          "strava.activity_id": row.stravaActivityId,
          "user.id": userId,
        },
      },
    );
  }
}
