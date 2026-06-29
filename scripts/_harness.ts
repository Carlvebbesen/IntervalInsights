import { and, count, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "../src/schema";
import { scriptRuns } from "../src/schema";

type Db = NodePgDatabase<typeof schema>;

interface RunScriptOptions {
  /** Stable identifier recorded in `script_runs.name`. Use the file basename. */
  name: string;
  /** When true, the script refuses to run again once a completed run exists. */
  once?: boolean;
  db: Db;
  pool: Pool;
  /** Free-form context persisted on the run row (args, flags, …). */
  meta?: Record<string, unknown>;
}

async function completedCount(db: Db, name: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(scriptRuns)
    .where(and(eq(scriptRuns.name, name), eq(scriptRuns.status, "completed")));
  return row?.n ?? 0;
}

/**
 * Wraps a script body so every production run is recorded in `script_runs`,
 * and `once` scripts behave like a migration: a second invocation is a no-op.
 *
 * Set `MARK_COMPLETE=1` to record a completed run WITHOUT executing the body —
 * used to baseline scripts already run in production before tracking existed.
 */
export async function runScript(opts: RunScriptOptions, body: () => Promise<void>): Promise<void> {
  const { name, once = false, db, pool, meta } = opts;

  if (process.env.MARK_COMPLETE === "1") {
    const startedAt = new Date();
    await db.insert(scriptRuns).values({
      name,
      status: "completed",
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      meta: { ...meta, baseline: true },
    });
    console.log(`[script:${name}] marked complete (baseline) — body not executed`);
    await pool.end().catch(() => {});
    return;
  }

  const prior = await completedCount(db, name);
  if (once && prior > 0) {
    console.log(`[script:${name}] run-once and already completed ${prior}x — skipping`);
    await pool.end().catch(() => {});
    return;
  }

  const startedAt = new Date();
  const [run] = await db
    .insert(scriptRuns)
    .values({ name, status: "running", startedAt, meta })
    .returning({ id: scriptRuns.id });

  try {
    await body();
    const finishedAt = new Date();
    await db
      .update(scriptRuns)
      .set({ status: "completed", finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
      .where(eq(scriptRuns.id, run.id));
    console.log(`[script:${name}] completed (run #${prior + 1})`);
    await pool.end().catch(() => {});
  } catch (err) {
    const finishedAt = new Date();
    await db
      .update(scriptRuns)
      .set({
        status: "failed",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
      .where(eq(scriptRuns.id, run.id))
      .catch(() => {});
    console.error(`[script:${name}] failed:`, err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
