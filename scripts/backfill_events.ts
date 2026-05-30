import { sleep } from "bun";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { activities } from "../src/schema";
import { detectAndPersistEvents } from "../src/services/event_detection_service";

const DELAY_MS = Number(process.env.DELAY_MS ?? 1500);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  console.log(
    `[backfill] delay=${DELAY_MS}ms limit=${LIMIT ?? "ALL"} dryRun=${DRY_RUN}`,
  );

  const rows = await db
    .select({
      id: activities.id,
      userId: activities.userId,
      title: activities.title,
      description: activities.description,
      notes: activities.notes,
      startDateLocal: activities.startDateLocal,
    })
    .from(activities)
    .orderBy(asc(activities.startDateLocal));

  const candidates = rows.filter(
    (r) =>
      (r.title?.trim()?.length ?? 0) > 0 ||
      (r.description?.trim()?.length ?? 0) > 0 ||
      (r.notes?.trim()?.length ?? 0) > 0,
  );

  const target = LIMIT ? candidates.slice(0, LIMIT) : candidates;

  console.log(
    `[backfill] total=${rows.length} withText=${candidates.length} willProcess=${target.length}`,
  );

  if (DRY_RUN) {
    console.log("[backfill] dry run — exiting without LLM calls");
    await pool.end();
    return;
  }

  let processed = 0;
  let errors = 0;

  for (const r of target) {
    processed += 1;
    const t0 = Date.now();
    try {
      await detectAndPersistEvents(db, {
        activityId: r.id,
        userId: r.userId,
        title: r.title ?? "",
        description: r.description ?? "",
        notes: r.notes ?? "",
        activityStartDateLocal: r.startDateLocal,
      });
    } catch (err) {
      errors += 1;
      console.error(`[backfill] activity=${r.id} failed:`, err);
    }
    console.log(
      `[backfill] progress ${processed}/${target.length} activity=${r.id} elapsed=${Date.now() - t0}ms`,
    );

    if (processed < target.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`[backfill] done. processed=${processed} errors=${errors}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("[backfill] fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
