import { sleep } from "bun";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import * as activityRepo from "../src/repositories/activity_repository";
import * as schema from "../src/schema";
import { activities, intervalSegments, users } from "../src/schema";
import {
  computeActivityHrStats,
  computeWorkHrStats,
  type WorkWindowSegment,
} from "../src/services/hr_stats_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { runScript } from "./_harness";

// Backfills median/mode (+ work-interval) HR stats onto activities that predate
// the analysis-pipeline change. Throttled per request to stay within Strava's
// read rate limits (100 req / 15 min). Re-runnable: only touches activities with
// hr_stats_computed_at IS NULL.

const DELAY_MS = Number(process.env.DELAY_MS ?? 1000);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  console.log(`[hr-backfill] delay=${DELAY_MS}ms limit=${LIMIT ?? "ALL"} dryRun=${DRY_RUN}`);

  const rows = await db
    .select({
      id: activities.id,
      stravaActivityId: activities.stravaActivityId,
      clerkId: users.clerkId,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.userId))
    .where(
      and(
        eq(activities.analysisStatus, "completed"),
        eq(activities.hasHeartrate, true),
        isNull(activities.hrStatsComputedAt),
      ),
    )
    .orderBy(asc(activities.startDateLocal));

  const target = LIMIT ? rows.slice(0, LIMIT) : rows;
  console.log(`[hr-backfill] candidates=${rows.length} willProcess=${target.length}`);

  if (DRY_RUN) {
    console.log("[hr-backfill] dry run — exiting without Strava calls");
    return;
  }

  // Cache one Strava token per user for the run.
  const tokenCache = new Map<string, string | null>();
  async function tokenFor(clerkId: string): Promise<string | null> {
    if (tokenCache.has(clerkId)) return tokenCache.get(clerkId) ?? null;
    try {
      const tokens = await getStravaAccessTokens(clerkId);
      tokenCache.set(clerkId, tokens.access_token);
      return tokens.access_token;
    } catch (err) {
      console.error(`[hr-backfill] no Strava token for clerk=${clerkId}:`, err);
      tokenCache.set(clerkId, null);
      return null;
    }
  }

  let processed = 0;
  let errors = 0;
  let skipped = 0;

  for (const r of target) {
    processed += 1;
    const t0 = Date.now();
    try {
      const token = await tokenFor(r.clerkId);
      if (!token) {
        skipped += 1;
        continue;
      }
      if (r.stravaActivityId == null) {
        skipped += 1;
        continue;
      }
      const streams = await stravaApiService.getActivityStreams(token, r.stravaActivityId, [
        "heartrate",
        "time",
      ]);
      const segments = await db
        .select({
          type: intervalSegments.type,
          timeSeriesEndTime: intervalSegments.timeSeriesEndTime,
          actualDuration: intervalSegments.actualDuration,
        })
        .from(intervalSegments)
        .where(eq(intervalSegments.activityId, r.id));

      const full = computeActivityHrStats(streams);
      const work = computeWorkHrStats(streams, segments as WorkWindowSegment[]);
      await activityRepo.updateHrStats(db, r.id, { full, work });
    } catch (err) {
      errors += 1;
      console.error(`[hr-backfill] activity=${r.id} failed:`, err);
    }
    console.log(
      `[hr-backfill] progress ${processed}/${target.length} activity=${r.id} elapsed=${Date.now() - t0}ms`,
    );

    if (processed < target.length) await sleep(DELAY_MS);
  }

  console.log(
    `[hr-backfill] done. processed=${processed} errors=${errors} skipped(noToken)=${skipped}`,
  );
}

runScript({ name: "backfill_hr_stats", once: true, db, pool }, main);
