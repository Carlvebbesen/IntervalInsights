import { createClerkClient } from "@clerk/backend";
import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { type InsertUser, users } from "../src/schema";
import { runScript } from "./_harness";

const DRY_RUN = process.env.DRY_RUN === "1";
const DELAY_MS = Number(process.env.DELAY_MS ?? 100);
const PAGE_SIZE = 100;

const STALE_PUBLIC_METADATA_KEYS = [
  "user_id",
  "intervals_connected",
  "role",
  "strava_connected",
] as const;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!process.env.CLERK_SECRET_KEY) {
  console.error("CLERK_SECRET_KEY is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

interface LinkedAccountsMetadata {
  strava?: { athlete_id?: number } | null;
  intervals?: { athlete_id?: string } | null;
}

async function main() {
  console.log(`[sync] dryRun=${DRY_RUN} delay=${DELAY_MS}ms`);

  let offset = 0;
  let total = 0;
  let dbUpdated = 0;
  let metadataCleaned = 0;
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
        const privateMetadata = clerkUser.privateMetadata as LinkedAccountsMetadata;
        const stravaId =
          privateMetadata.strava?.athlete_id != null
            ? String(privateMetadata.strava.athlete_id)
            : null;
        const intervalsAthleteId = privateMetadata.intervals?.athlete_id ?? null;

        const dbUser = await db.query.users.findFirst({
          where: eq(users.clerkId, clerkUser.id),
        });

        if (!dbUser) {
          missingDbUser += 1;
          console.warn(`[sync] clerk=${clerkUser.id} has no users row — skipping db update`);
        } else {
          const updates: Partial<InsertUser> = {};
          const changes: string[] = [];
          if (stravaId !== dbUser.stravaId) {
            updates.stravaId = stravaId;
            changes.push(`stravaId ${dbUser.stravaId} -> ${stravaId}`);
          }
          if (intervalsAthleteId !== dbUser.intervalsAthleteId) {
            updates.intervalsAthleteId = intervalsAthleteId;
            changes.push(`intervalsAthleteId ${dbUser.intervalsAthleteId} -> ${intervalsAthleteId}`);
          }

          if (changes.length > 0) {
            dbUpdated += 1;
            console.log(`[sync] clerk=${clerkUser.id} db update: ${changes.join(", ")}`);
            if (!DRY_RUN) {
              await db.update(users).set(updates).where(eq(users.id, dbUser.id));
            }
          }
        }

        const staleKeys = STALE_PUBLIC_METADATA_KEYS.filter(
          (key) => clerkUser.publicMetadata[key] !== undefined,
        );
        if (staleKeys.length > 0) {
          metadataCleaned += 1;
          console.log(`[sync] clerk=${clerkUser.id} removing metadata: ${staleKeys.join(", ")}`);
          if (!DRY_RUN) {
            await clerkClient.users.updateUserMetadata(clerkUser.id, {
              publicMetadata: Object.fromEntries(
                STALE_PUBLIC_METADATA_KEYS.map((key) => [key, null]),
              ),
            });
          }
        }
      } catch (err) {
        errors += 1;
        console.error(`[sync] clerk=${clerkUser.id} failed:`, err);
      }
      await sleep(DELAY_MS);
    }

    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) break;
  }

  console.log(
    `[sync] done. total=${total} dbUpdated=${dbUpdated} metadataCleaned=${metadataCleaned} ` +
      `missingDbUser=${missingDbUser} errors=${errors}`,
  );
}

runScript({ name: "sync_clerk_to_db", once: true, db, pool }, main);
