import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { userSettings, users } from "../src/schema";
import { runScript } from "./_harness";

// One-time materialization of `user_settings` rows for every existing `users`
// row, seeded from the legacy `maxHeartRate`/`processHeartRate` columns.
// Idempotent via onConflictDoNothing — an already-materialized row (created
// lazily by getOrCreateUserSettings) wins, matching that function's seeding
// contract. DRY_RUN=1 reports counts without writing.

const DRY_RUN = process.env.DRY_RUN === "1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  console.log(`[backfill_user_settings] dryRun=${DRY_RUN}`);

  const userRows = await db
    .select({
      id: users.id,
      maxHeartRate: users.maxHeartRate,
      processHeartRate: users.processHeartRate,
    })
    .from(users);

  console.log(`[backfill_user_settings] totalUsers=${userRows.length}`);

  if (DRY_RUN) {
    console.log("[backfill_user_settings] dry run — exiting without writes");
    return;
  }

  let inserted = 0;
  let skippedExisting = 0;

  for (const user of userRows) {
    const [row] = await db
      .insert(userSettings)
      .values({
        userId: user.id,
        maxHeartRate: user.maxHeartRate,
        processHeartRate: user.processHeartRate,
      })
      .onConflictDoNothing()
      .returning({ userId: userSettings.userId });
    if (row) inserted += 1;
    else skippedExisting += 1;
  }

  console.log(
    `[backfill_user_settings] done. totalUsers=${userRows.length} inserted=${inserted} skippedExisting=${skippedExisting}`,
  );
}

runScript({ name: "backfill_user_settings", once: true, db, pool }, main);
