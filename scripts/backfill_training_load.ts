import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { logger } from "../src/logger";
import * as schema from "../src/schema";
import { activities, users } from "../src/schema";
import { computeAndStoreActivityLoadWithThresholds } from "../src/services/activity_load_service";
import { buildHistoricalThresholdResolver } from "../src/services/threshold_service";
import { runScript } from "./_harness";

// Historical load backfill: for every activity with a null `training_load`,
// resolve thresholds as-of the activity's `start_date_local` and self-compute
// the load. Idempotent/resumable — already-computed rows are filtered out at the
// query level. Per-activity errors are logged and skipped, never aborting the
// run. DRY_RUN=1 computes and logs but writes nothing. USER_ID limits to one user.

const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_USER_ID = process.env.USER_ID ?? null;
const PROGRESS_EVERY = 50;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

interface Counts {
  success: number;
  skipped: number;
  failed: number;
}

async function backfillUser(userId: string, counts: Counts): Promise<void> {
  const resolver = await buildHistoricalThresholdResolver(db, userId);

  const pending = await db
    .select({ id: activities.id, startDateLocal: activities.startDateLocal })
    .from(activities)
    .where(and(eq(activities.userId, userId), isNull(activities.trainingLoad)))
    .orderBy(asc(activities.startDateLocal));

  console.log(`[backfill_training_load] user=${userId} pending=${pending.length}`);

  let processed = 0;
  for (const act of pending) {
    try {
      const thresholds = await resolver(act.startDateLocal);
      const result = await computeAndStoreActivityLoadWithThresholds(db, userId, act.id, thresholds, {
        dryRun: DRY_RUN,
      });
      if (result) {
        counts.success += 1;
        if (DRY_RUN) {
          console.log(
            `[backfill_training_load] would set activity=${act.id} load=${result.load} source=${result.source}`,
          );
        }
      } else {
        counts.skipped += 1;
      }
    } catch (err) {
      counts.failed += 1;
      logger.warn({ err, userId, activityId: act.id }, "backfill_training_load: activity failed");
    }
    processed += 1;
    if (processed % PROGRESS_EVERY === 0) {
      console.log(
        `[backfill_training_load] user=${userId} progress=${processed}/${pending.length} success=${counts.success} skipped=${counts.skipped} failed=${counts.failed}`,
      );
    }
  }
}

async function main(): Promise<Record<string, unknown>> {
  console.log(`[backfill_training_load] dryRun=${DRY_RUN} onlyUserId=${ONLY_USER_ID ?? "<all>"}`);

  const userRows = ONLY_USER_ID
    ? [{ id: ONLY_USER_ID }]
    : await db.select({ id: users.id }).from(users);

  console.log(`[backfill_training_load] users=${userRows.length}`);

  const counts: Counts = { success: 0, skipped: 0, failed: 0 };
  for (const user of userRows) {
    await backfillUser(user.id, counts);
  }

  console.log(
    `[backfill_training_load] done. users=${userRows.length} success=${counts.success} skipped=${counts.skipped} failed=${counts.failed}`,
  );
  return { ...counts, users: userRows.length, dryRun: DRY_RUN };
}

runScript(
  { name: "backfill_training_load", once: false, db, pool, meta: { dryRun: DRY_RUN } },
  () => main(),
);
