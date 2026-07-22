import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { scriptRuns } from "../src/schema";
import { type TrackedScript, discoverTrackedScripts, findRegistryDrift } from "./_discover";
import { ONCE_SCRIPTS } from "./_registry";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface RunSummary {
  completed: number;
  failed: number;
  running: number;
  lastCompletedAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  baseline: boolean;
}

// `--once` narrows the report to the deploy gate (migrations + run-once scripts).
// Without it the report also lists the manually-run scripts, whose run history is
// otherwise invisible even though the harness records it.
const ONCE_ONLY = process.argv.includes("--once");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? "?";

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

async function loadRuns(): Promise<Map<string, RunSummary>> {
  const rows = await db
    .select({
      name: scriptRuns.name,
      status: scriptRuns.status,
      startedAt: scriptRuns.startedAt,
      finishedAt: scriptRuns.finishedAt,
      meta: scriptRuns.meta,
    })
    .from(scriptRuns);

  const byName = new Map<string, RunSummary>();
  for (const row of rows) {
    const s: RunSummary = byName.get(row.name) ?? {
      completed: 0,
      failed: 0,
      running: 0,
      lastCompletedAt: null,
      lastRunAt: null,
      lastStatus: null,
      baseline: false,
    };

    if (row.status === "completed") s.completed++;
    else if (row.status === "failed") s.failed++;
    else s.running++;

    if (row.status === "completed" && (!s.lastCompletedAt || row.startedAt > s.lastCompletedAt)) {
      s.lastCompletedAt = row.finishedAt ?? row.startedAt;
      s.baseline = row.meta?.baseline === true;
    }
    if (!s.lastRunAt || row.startedAt > s.lastRunAt) {
      s.lastRunAt = row.startedAt;
      s.lastStatus = row.status;
    }
    byName.set(row.name, s);
  }
  return byName;
}

function onceStatus(runs: Map<string, RunSummary>): number {
  console.log("\n── Run-once scripts (scripts/) ──");
  let pending = 0;
  for (const name of ONCE_SCRIPTS) {
    const s = runs.get(name);
    if (s?.completed) {
      const baseline = s.baseline ? " (baseline — body never ran)" : "";
      console.log(`  ✓ ${name} — completed ${day(s.lastCompletedAt)}${baseline}`);
      continue;
    }
    pending++;
    const detail = s?.failed
      ? ` (last run FAILED ${day(s.lastRunAt)})`
      : s?.running
        ? ` (a run has been stuck at running since ${day(s.lastRunAt)})`
        : "";
    console.log(`  ✗ ${name} — PENDING${detail}`);
  }
  console.log(
    pending === 0
      ? `  ${ONCE_SCRIPTS.length} completed, none pending.`
      : `  ${ONCE_SCRIPTS.length - pending} completed, ${pending} pending → bun run scripts:run`,
  );
  return pending;
}

function manualStatus(tracked: TrackedScript[], runs: Map<string, RunSummary>): void {
  const manual = tracked.filter((t) => !t.once);
  console.log("\n── Manually-run scripts (scripts/) ──");
  console.log("  No pending state — each is run by hand when its rollout calls for it.");
  const width = Math.max(...manual.map((t) => t.name.length));
  for (const t of manual) {
    const s = runs.get(t.name);
    const name = t.name.padEnd(width);
    if (!s?.completed) {
      const detail = s?.failed ? ` (last run FAILED ${day(s.lastRunAt)})` : "";
      console.log(`  ✗ ${name}  never completed${detail}`);
      continue;
    }
    const plural = s.completed === 1 ? "" : "s";
    const stale = s.lastStatus === "completed" ? "" : ` — last run ${s.lastStatus?.toUpperCase()} ${day(s.lastRunAt)}`;
    console.log(`  ✓ ${name}  last ${day(s.lastCompletedAt)}, ${s.completed} run${plural}${stale}`);
  }
}

async function main() {
  const tracked = await discoverTrackedScripts();
  const pendingMigrations = await migrationStatus();
  const runs = await loadRuns();
  const pendingOnce = onceStatus(runs);
  if (!ONCE_ONLY) manualStatus(tracked, runs);

  const drift = findRegistryDrift(tracked, ONCE_SCRIPTS);
  if (drift.length > 0) {
    console.log("\n── Registry drift (scripts/_registry.ts) ──");
    for (const problem of drift) console.log(`  ⚠ ${problem}`);
  }

  await pool.end();
  process.exit(pendingMigrations + pendingOnce + drift.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[status] fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
