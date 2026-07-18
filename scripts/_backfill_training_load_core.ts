import { and, asc, eq, isNull } from "drizzle-orm";
import { logger } from "../src/logger";
import { activities } from "../src/schema";
import { computeAndStoreActivityLoadWithThresholds } from "../src/services/activity_load_service";
import type { ResolvedThresholds } from "../src/services/threshold_service";
import type { IGlobalBindings } from "../src/types/IRouters";

// Testable core of the backfill loop (non-self-executing `_`-module, like
// `_load_comparison`). The script wires the real resolver + compute step in;
// tests inject fakes to pin the loop invariants.

type Db = IGlobalBindings["db"];

export interface BackfillCounts {
  success: number;
  skipped: number;
  failed: number;
}

export interface BackfillUserOptions {
  dryRun: boolean;
  onProgress?: (processed: number, total: number) => void;
  onResult?: (activityId: number, result: { load: number; source: string }) => void;
  progressEvery?: number;
  computeFn?: typeof computeAndStoreActivityLoadWithThresholds;
}

/**
 * Backfill one user's null-load activities oldest-first. Already-computed rows
 * are excluded at the query level (idempotent/resumable); a per-activity error
 * is counted and skipped, never aborting the run.
 */
export async function backfillUserLoads(
  db: Db,
  userId: string,
  resolveAsOf: (asOf: Date) => Promise<ResolvedThresholds>,
  counts: BackfillCounts,
  opts: BackfillUserOptions,
): Promise<void> {
  const compute = opts.computeFn ?? computeAndStoreActivityLoadWithThresholds;
  const progressEvery = opts.progressEvery ?? 50;

  const pending = await db
    .select({ id: activities.id, startDateLocal: activities.startDateLocal })
    .from(activities)
    .where(and(eq(activities.userId, userId), isNull(activities.trainingLoad)))
    .orderBy(asc(activities.startDateLocal));

  let processed = 0;
  for (const act of pending) {
    try {
      const thresholds = await resolveAsOf(act.startDateLocal);
      const result = await compute(db, userId, act.id, thresholds, { dryRun: opts.dryRun });
      if (result) {
        counts.success += 1;
        opts.onResult?.(act.id, result);
      } else counts.skipped += 1;
    } catch (err) {
      counts.failed += 1;
      logger.warn({ err, userId, activityId: act.id }, "backfill_training_load: activity failed");
    }
    processed += 1;
    if (processed % progressEvery === 0) opts.onProgress?.(processed, pending.length);
  }
  opts.onProgress?.(processed, pending.length);
}
