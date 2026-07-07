// Phase 1 backfill: copy the Strava + intervals.icu OAuth tokens that used to
// live in Clerk `privateMetadata` into the encrypted `oauth_provider_tokens`
// table, keyed by the internal user id. Idempotent (per-provider upsert) and
// re-runnable — run it periodically during the dual-auth window and once right
// before the Phase 6 cutover. DRY_RUN=1 reports without writing.
//
//   DRY_RUN=1 bun run scripts/backfill_oauth_tokens.ts   # preview
//   bun run scripts/backfill_oauth_tokens.ts             # write

import { createClerkClient } from "@clerk/backend";
import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { users } from "../src/schema";
import { writeProviderToken } from "../src/services/oauth_token_store";
import { runScript } from "./_harness";

const DRY_RUN = process.env.DRY_RUN === "1";
const DELAY_MS = Number(process.env.DELAY_MS ?? 100);
const PAGE_SIZE = 100;

for (const required of ["DATABASE_URL", "CLERK_SECRET_KEY", "TOKEN_ENC_KEY"]) {
  if (!process.env[required]) {
    console.error(`${required} is required`);
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

interface ProviderMetadata {
  strava?: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    athlete_id?: number;
  } | null;
  intervals?: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    athlete_id?: string;
  } | null;
}

async function main() {
  console.log(`[backfill_oauth_tokens] dryRun=${DRY_RUN} delay=${DELAY_MS}ms`);

  let offset = 0;
  let total = 0;
  let stravaWritten = 0;
  let intervalsWritten = 0;
  let missingDbUser = 0;
  let errors = 0;

  for (;;) {
    const page = await clerkClient.users.getUserList({
      limit: PAGE_SIZE,
      offset,
      orderBy: "+created_at",
    });

    for (const clerkUser of page.data) {
      total += 1;
      try {
        const metadata = clerkUser.privateMetadata as ProviderMetadata;
        const dbUser = await db.query.users.findFirst({
          columns: { id: true },
          where: eq(users.clerkId, clerkUser.id),
        });
        if (!dbUser) {
          missingDbUser += 1;
          console.warn(`[backfill] clerk=${clerkUser.id} has no users row — skipping`);
          await sleep(DELAY_MS);
          continue;
        }

        const strava = metadata.strava;
        if (strava?.access_token && strava?.refresh_token) {
          console.log(`[backfill] clerk=${clerkUser.id} strava token`);
          if (!DRY_RUN) {
            await writeProviderToken(db, dbUser.id, "strava", {
              access_token: strava.access_token,
              refresh_token: strava.refresh_token,
              expires_at: strava.expires_at,
              athlete_id: strava.athlete_id != null ? String(strava.athlete_id) : undefined,
            });
          }
          stravaWritten += 1;
        }

        const intervals = metadata.intervals;
        if (intervals?.access_token) {
          console.log(`[backfill] clerk=${clerkUser.id} intervals token`);
          if (!DRY_RUN) {
            await writeProviderToken(db, dbUser.id, "intervals", {
              access_token: intervals.access_token,
              refresh_token: intervals.refresh_token,
              expires_at: intervals.expires_at,
              athlete_id: intervals.athlete_id != null ? String(intervals.athlete_id) : undefined,
            });
          }
          intervalsWritten += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(`[backfill] clerk=${clerkUser.id} failed:`, err);
      }
      await sleep(DELAY_MS);
    }

    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) break;
  }

  console.log(
    `[backfill_oauth_tokens] done. total=${total} strava=${stravaWritten} ` +
      `intervals=${intervalsWritten} missingDbUser=${missingDbUser} errors=${errors}`,
  );
}

runScript({ name: "backfill_oauth_tokens", once: false, db, pool }, main);
