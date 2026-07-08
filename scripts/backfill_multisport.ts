import { sleep } from "bun";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { StravaError } from "../src/error";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import * as schema from "../src/schema";
import { RUNNING_SPORT_TYPES } from "../src/schema";
import { syncUserGearFromStrava } from "../src/services/gear_strava_service";
import { ANALYZED_SPORT_TYPES } from "../src/services/utils";
import { runScript } from "./_harness";

/**
 * Multisport rollout backfill (D10). Two steps, both idempotent:
 *   sync  — for every Strava-linked user, import bikes[] as BICYCLE gear and link
 *           historic Ride/VirtualRide/etc. activities to them by stored gear_id
 *           (the same syncUserGearFromStrava the in-app "Sync from Strava" runs,
 *           which now also does bikes + ride linking + baselines).
 *   reset — flip already-imported NON-running activities (ride/ski/elliptical/
 *           hike/rowing) that were stored WITHOUT analysis — intervals-sync
 *           `completed` rows with no analysis (analyzed_at IS NULL) and
 *           `skipped_inactive` rows — back to `pending`, so GET /agents/pending
 *           re-queues them through the now sport-aware pipeline.
 *
 * MUTATES the dev DB (unless DRY_RUN) and calls the Strava API. Run:
 *   DRY_RUN=1 bun run scripts/backfill_multisport.ts             # report only, no writes
 *   ONLY_STEP=sync  bun run scripts/backfill_multisport.ts       # bikes sync + linking only
 *   ONLY_STEP=reset bun run scripts/backfill_multisport.ts       # re-queue non-run imports only
 *   ONLY_CLERK_ID=user_xxx bun run scripts/backfill_multisport.ts   # scope to one user
 *   LIMIT=5 DELAY_MS=2000 bun run scripts/backfill_multisport.ts
 */

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const ONLY_CLERK_ID = process.env.ONLY_CLERK_ID; // NB: not `USER` (shell sets that)
const ONLY_STEP = process.env.ONLY_STEP as "sync" | "reset" | undefined;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const DELAY_MS = Number(process.env.DELAY_MS ?? 1500);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

/** Analyzable non-running sports — the D6 set minus runs. These are what the
 * old ingest filter dropped and the intervals sync stored without analysis. */
const NON_RUNNING_SPORT_TYPES = [...ANALYZED_SPORT_TYPES].filter(
  (s) => !(RUNNING_SPORT_TYPES as readonly string[]).includes(s),
);

async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StravaError && e.status === 429) {
      console.log("[backfill-multisport] rate-limited (429) — backing off 60s");
      await sleep(60_000);
      return fn();
    }
    throw e;
  }
}

async function syncGear(): Promise<void> {
  let users = await db
    .select({ id: schema.users.id, clerkId: schema.users.clerkId })
    .from(schema.users)
    .where(isNotNull(schema.users.stravaId));
  if (ONLY_CLERK_ID) users = users.filter((u) => u.clerkId === ONLY_CLERK_ID);
  if (LIMIT) users = users.slice(0, LIMIT);

  console.log(
    `[backfill-multisport] sync: ${users.length} strava-linked user(s)${ONLY_CLERK_ID ? ` (scoped to ${ONLY_CLERK_ID})` : ""}${DRY_RUN ? " — DRY_RUN" : ""}`,
  );

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalLinked = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    let token: string;
    try {
      token = (await getStravaAccessTokens(u.id)).access_token;
    } catch {
      console.log(
        `[backfill-multisport] sync ${i + 1}/${users.length} user=${u.id} — no Strava token, skipping`,
      );
      continue;
    }

    try {
      const res = await runWithRetry(() =>
        syncUserGearFromStrava(db, u.id, token, { dryRun: DRY_RUN }),
      );
      totalCreated += res.created;
      totalUpdated += res.updated;
      totalLinked += res.linked;
      console.log(
        `[backfill-multisport] sync ${i + 1}/${users.length} user=${u.id} created=${res.created} updated=${res.updated} linked=${res.linked}`,
      );
    } catch (e) {
      failed++;
      console.log(
        `[backfill-multisport] sync ${i + 1}/${users.length} user=${u.id} FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (i < users.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    `[backfill-multisport] sync done. created=${totalCreated} updated=${totalUpdated} linked=${totalLinked} failed=${failed}${DRY_RUN ? " (DRY_RUN — nothing written)" : ""}`,
  );
}

async function resetUnanalyzed(): Promise<void> {
  let userId: string | undefined;
  if (ONLY_CLERK_ID) {
    const [u] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.clerkId, ONLY_CLERK_ID));
    if (!u) {
      console.log(`[backfill-multisport] reset: no user for clerkId ${ONLY_CLERK_ID}`);
      return;
    }
    userId = u.id;
  }

  // Non-running imports that never went through the pipeline: intervals-sync
  // `completed` rows (analyzed_at still null) and inactivity-skipped rows.
  const unanalyzed = or(
    and(eq(schema.activities.analysisStatus, "completed"), isNull(schema.activities.analyzedAt)),
    eq(schema.activities.analysisStatus, "skipped_inactive"),
  );
  const filter = and(
    inArray(schema.activities.sportType, NON_RUNNING_SPORT_TYPES),
    unanalyzed,
    userId ? eq(schema.activities.userId, userId) : undefined,
  );

  if (DRY_RUN) {
    const rows = await db
      .select({
        sportType: schema.activities.sportType,
        analysisStatus: schema.activities.analysisStatus,
      })
      .from(schema.activities)
      .where(filter);
    const bySport = new Map<string, number>();
    for (const r of rows) bySport.set(r.sportType, (bySport.get(r.sportType) ?? 0) + 1);
    console.log(
      `[backfill-multisport] reset: WOULD re-queue ${rows.length} non-run activity(ies) to pending${ONLY_CLERK_ID ? ` (scoped to ${ONLY_CLERK_ID})` : ""} — ${[...bySport.entries()].map(([s, n]) => `${s}=${n}`).join(", ") || "none"} (DRY_RUN — nothing written)`,
    );
    return;
  }

  const reset = await db
    .update(schema.activities)
    .set({ analysisStatus: "pending" })
    .where(filter)
    .returning({ id: schema.activities.id, sportType: schema.activities.sportType });
  const bySport = new Map<string, number>();
  for (const r of reset) bySport.set(r.sportType, (bySport.get(r.sportType) ?? 0) + 1);
  console.log(
    `[backfill-multisport] reset done. re-queued ${reset.length} activity(ies) to pending — ${[...bySport.entries()].map(([s, n]) => `${s}=${n}`).join(", ") || "none"}`,
  );
}

async function main() {
  if (ONLY_STEP !== "reset") await syncGear();
  if (ONLY_STEP !== "sync") await resetUnanalyzed();
}

runScript(
  { name: "backfill_multisport", once: false, db, pool, meta: { onlyStep: ONLY_STEP ?? "all" } },
  main,
);
