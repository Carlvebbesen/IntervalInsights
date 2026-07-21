// Shared Postgres pool + per-suite test user seeding/cleanup.

import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { activities, events, users } from "../../src/schema";
import * as schema from "../../src/schema";
import { writeProviderToken } from "../../src/services/oauth_token_store";

// Far-future provider tokens, seeded (encrypted) into `oauth_provider_tokens`
// so the real strava/intervals middlewares resolve for every test user by default.
const TOKEN_FAR_FUTURE = Math.floor(Date.now() / 1000) + 86_400;

// `users.email` is NOT NULL + UNIQUE, so every seeded user needs its own address.
// The prefix is also what purgeOrphanedTestUsers() matches on.
const TEST_EMAIL_PREFIX = "test-user-";
const TEST_EMAIL_DOMAIN = "@test.local";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let sharedPool: Pool | null = null;

export function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must be set for endpoint tests. " +
        "Start the dev DB with `docker compose up -d` and export DATABASE_URL.",
    );
  }
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  }
  return sharedPool;
}

export function getDb() {
  return drizzle({ client: getPool(), schema });
}

export async function closePool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

/** Create a fresh test user. Caller passes a deterministic suffix for readability. */
export async function createTestUser(opts?: {
  role?: "guest" | "premium" | "admin";
  processHeartRate?: boolean;
  maxHeartRate?: number;
  /** Seed encrypted Strava tokens so strava-guarded routes resolve (default true). */
  strava?: boolean;
  /** Seed encrypted intervals.icu tokens so intervals-guarded routes resolve (default true). */
  intervals?: boolean;
}) {
  const db = getDb();
  const email = `${TEST_EMAIL_PREFIX}${randomUUID()}${TEST_EMAIL_DOMAIN}`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      role: opts?.role ?? "premium",
      processHeartRate: opts?.processHeartRate ?? false,
      maxHeartRate: opts?.maxHeartRate,
    })
    .returning();

  if (opts?.strava !== false) {
    await writeProviderToken(db, user.id, "strava", {
      access_token: "test-strava-token",
      refresh_token: "test-strava-refresh",
      expires_at: TOKEN_FAR_FUTURE,
      athlete_id: "12345",
    });
  }
  if (opts?.intervals !== false) {
    await writeProviderToken(db, user.id, "intervals", {
      access_token: "test-intervals-token",
      refresh_token: "test-intervals-refresh",
      expires_at: TOKEN_FAR_FUTURE,
      athlete_id: "i12345",
    });
  }
  return { id: user.id, email };
}

/**
 * Remove every row that depends (transitively) on a test user, then the user.
 * Order matters because FKs from users.id are ON DELETE NO ACTION.
 */
export async function deleteTestUser(userId: string) {
  const pool = getPool();
  // event_attributes + activity_events cascade from events; activity_events +
  // interval_segments cascade from activities; gear_defaults cascade from gears;
  // training_plan_weeks + planned_sessions cascade from training_plans.
  await pool.query(`DELETE FROM training_plans WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM race_events WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM chat_conversations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM events WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM activities WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM gears WHERE user_id = $1`, [userId]);
  await pool.query(
    `DELETE FROM feedback_training_data WHERE user_id = $1`,
    [userId],
  ).catch(() => {
    /* table may not exist in older migrations */
  });
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

/** Bulk-cleanup helper: nuke every seeded test user the suite may have left behind. */
export async function purgeOrphanedTestUsers() {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE $1`,
    [`${TEST_EMAIL_PREFIX}%${TEST_EMAIL_DOMAIN}`],
  );
  for (const row of rows) {
    await deleteTestUser(row.id);
  }
}
