import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { users } from "../src/schema";
import { buildHistoricalThresholdResolver } from "../src/services/threshold_service";
import { type BackfillCounts, backfillUserLoads } from "./_backfill_training_load_core";
import { runScript } from "./_harness";

// Historical load backfill: for every activity with a null `training_load`,
// resolve thresholds as-of the activity's `start_date_local` and self-compute
// the load. Loop invariants (idempotency, error-continue, dry-run) live in
// `_backfill_training_load_core.ts` and are covered by tests there.
// DRY_RUN=1 computes and logs but writes nothing. USER_ID limits to one user.

const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_USER_ID = process.env.USER_ID ?? null;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main(): Promise<Record<string, unknown>> {
  console.log(`[backfill_training_load] dryRun=${DRY_RUN} onlyUserId=${ONLY_USER_ID ?? "<all>"}`);

  const userRows = ONLY_USER_ID
    ? [{ id: ONLY_USER_ID }]
    : await db.select({ id: users.id }).from(users);

  console.log(`[backfill_training_load] users=${userRows.length}`);

  const counts: BackfillCounts = { success: 0, skipped: 0, failed: 0 };
  for (const user of userRows) {
    const resolver = await buildHistoricalThresholdResolver(db, user.id);
    await backfillUserLoads(db, user.id, resolver, counts, {
      dryRun: DRY_RUN,
      onProgress: (processed, total) =>
        console.log(
          `[backfill_training_load] user=${user.id} progress=${processed}/${total} success=${counts.success} skipped=${counts.skipped} failed=${counts.failed}`,
        ),
      onResult: DRY_RUN
        ? (activityId, r) =>
            console.log(
              `[backfill_training_load] would set activity=${activityId} load=${r.load} source=${r.source}`,
            )
        : undefined,
    });
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
