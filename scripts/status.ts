import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { scriptRuns } from "../src/schema";
import { ONCE_SCRIPTS } from "./_registry";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function lastAppliedMigrationMillis(): Promise<number> {
  try {
    const res = await pool.query<{ created_at: string }>(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    );
    return res.rows[0] ? Number(res.rows[0].created_at) : 0;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return 0; // fresh DB, table not created yet
    throw err;
  }
}

async function migrationStatus(): Promise<number> {
  const journal = (await Bun.file(new URL("../drizzle/meta/_journal.json", import.meta.url)).json()) as {
    entries: JournalEntry[];
  };
  // Mirrors drizzle's migrator: an entry is pending when its journal
  // timestamp is newer than the last row in drizzle.__drizzle_migrations.
  const lastApplied = await lastAppliedMigrationMillis();

  console.log("── Drizzle migrations (drizzle/) ──");
  let pending = 0;
  for (const entry of journal.entries) {
    if (entry.when > lastApplied) {
      pending++;
      console.log(`  ✗ ${entry.tag} — PENDING`);
    } else {
      console.log(`  ✓ ${entry.tag}`);
    }
  }
  const applied = journal.entries.length - pending;
  console.log(
    pending === 0
      ? `  ${applied} applied, none pending.`
      : `  ${applied} applied, ${pending} pending → bun run db:migrate`,
  );
  return pending;
}

async function scriptStatus(): Promise<number> {
  console.log("\n── Run-once scripts (scripts/) ──");
  let pending = 0;
  for (const name of ONCE_SCRIPTS) {
    const [done] = await db
      .select({ finishedAt: scriptRuns.finishedAt })
      .from(scriptRuns)
      .where(and(eq(scriptRuns.name, name), eq(scriptRuns.status, "completed")))
      .orderBy(desc(scriptRuns.finishedAt))
      .limit(1);
    if (done) {
      console.log(`  ✓ ${name} — completed ${done.finishedAt?.toISOString().slice(0, 10) ?? "(baseline)"}`);
    } else {
      pending++;
      console.log(`  ✗ ${name} — PENDING`);
    }
  }
  console.log(
    pending === 0
      ? `  ${ONCE_SCRIPTS.length} completed, none pending.`
      : `  ${ONCE_SCRIPTS.length - pending} completed, ${pending} pending → bun run scripts:run`,
  );
  return pending;
}

async function main() {
  const pendingMigrations = await migrationStatus();
  const pendingScripts = await scriptStatus();
  await pool.end();
  process.exit(pendingMigrations + pendingScripts > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[status] fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
