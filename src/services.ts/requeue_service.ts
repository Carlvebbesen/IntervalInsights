import { sql } from "drizzle-orm";
import { activities } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { startAnalysis } from "./analysis_service";

const REQUEUE_BATCH_LIMIT = 100;
const ERROR_RETRY_CAP = 2;

export async function requeueStaleActivities(
  db: IGlobalBindings["db"],
  userId: string,
  stravaAccessToken: string,
): Promise<void> {
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
          )
        LIMIT ${REQUEUE_BATCH_LIMIT}
      )`,
    )
    .returning({ id: activities.id, stravaActivityId: activities.stravaActivityId });

  for (const row of requeued) {
    void startAnalysis(db, stravaAccessToken, row.id, row.stravaActivityId, userId);
  }
}
