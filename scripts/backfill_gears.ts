import { sleep } from "bun";
import { isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { StravaError } from "../src/error";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import * as schema from "../src/schema";
import { syncUserGearFromStrava } from "../src/services/gear_strava_service";

/**
 * Seed local gear from Strava for every Strava-linked user: imports each user's
 * shoes, links their existing activities, and snapshots distances. Idempotent —
 * re-running resyncs existing shoes and links any new activities. The per-user
 * routine is the same one the in-app "Sync from Strava" button uses.
 *
 * MUTATES the dev DB (unless DRY_RUN) and calls the Strava API. Run:
 *   DRY_RUN=1 bun run scripts/backfill_gears.ts          # report only, no writes
 *   ONLY_CLERK_ID=user_xxx bun run scripts/backfill_gears.ts   # scope to one user
 *   LIMIT=5 DELAY_MS=2000 bun run scripts/backfill_gears.ts
 */

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const ONLY_CLERK_ID = process.env.ONLY_CLERK_ID; // NB: not `USER` (shell sets that)
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const DELAY_MS = Number(process.env.DELAY_MS ?? 1500);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StravaError && e.status === 429) {
      console.log("[backfill-gears] rate-limited (429) — backing off 60s");
      await sleep(60_000);
      return fn();
    }
    throw e;
  }
}

async function main() {
  let users = await db
    .select({ id: schema.users.id, clerkId: schema.users.clerkId })
    .from(schema.users)
    .where(isNotNull(schema.users.stravaId));
  if (ONLY_CLERK_ID) users = users.filter((u) => u.clerkId === ONLY_CLERK_ID);
  if (LIMIT) users = users.slice(0, LIMIT);

  console.log(
    `[backfill-gears] ${users.length} strava-linked user(s)${ONLY_CLERK_ID ? ` (scoped to ${ONLY_CLERK_ID})` : ""}${DRY_RUN ? " — DRY_RUN" : ""}`,
  );

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalLinked = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    let token: string;
    try {
      token = (await getStravaAccessTokens(u.clerkId)).access_token;
    } catch {
      console.log(`[backfill-gears] ${i + 1}/${users.length} user=${u.id} — no Strava token, skipping`);
      continue;
    }

    try {
      const res = await runWithRetry(() => syncUserGearFromStrava(db, u.id, token, { dryRun: DRY_RUN }));
      totalCreated += res.created;
      totalUpdated += res.updated;
      totalLinked += res.linked;
      console.log(
        `[backfill-gears] ${i + 1}/${users.length} user=${u.id} created=${res.created} updated=${res.updated} linked=${res.linked}`,
      );
    } catch (e) {
      failed++;
      console.log(
        `[backfill-gears] ${i + 1}/${users.length} user=${u.id} FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (i < users.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    `[backfill-gears] done. created=${totalCreated} updated=${totalUpdated} linked=${totalLinked} failed=${failed}${DRY_RUN ? " (DRY_RUN — nothing written)" : ""}`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error("[backfill-gears] fatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
