import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, eq, asc } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { intervalSegments } from "../src/schema";
import { expandRestSegments } from "../src/services/segment_fold_service";
import { runScript } from "./_harness";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function snapshot(aid: number) {
  const rows = await db
    .select()
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, aid))
    .orderBy(asc(intervalSegments.segmentIndex));
  return {
    types: rows.map((r) => r.type).join(","),
    ends: JSON.stringify(rows.map((r) => r.timeSeriesEndTime)),
    restStats: JSON.stringify(
      rows.filter((r) => r.type === "REST").map((r) => [r.actualDuration, r.avgHeartRate]),
    ),
  };
}

async function main() {
  await db.execute(sql`DROP TABLE IF EXISTS interval_segments_backup_optionb`);
  await db.execute(sql`CREATE TABLE interval_segments_backup_optionb AS TABLE interval_segments`);
  const before = (
    await db.execute(
      sql`SELECT count(*) FILTER (WHERE type='REST') rests, count(*) total FROM interval_segments`,
    )
  ).rows[0];
  console.log("[backup] interval_segments_backup_optionb created; before:", before);

  const sampleRows = await db.execute(
    sql`SELECT DISTINCT activity_id FROM interval_segments WHERE type='REST' ORDER BY activity_id LIMIT 8`,
  );
  const samples = sampleRows.rows.map((r: any) => Number(r.activity_id));
  const originals: Record<number, Awaited<ReturnType<typeof snapshot>>> = {};
  for (const a of samples) originals[a] = await snapshot(a);

  const file = readFileSync(new URL("./backfill_fold_rest_segments.sql", import.meta.url), "utf8");
  const stmts = file
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);

  let ok = true;
  try {
    await db.transaction(async (tx) => {
      for (const s of stmts) await tx.execute(sql.raw(s));
      const after = (
        await tx.execute(
          sql`SELECT count(*) FILTER (WHERE type='REST') rests, count(*) FILTER (WHERE type='INTERVALS' AND recovery_end_time IS NOT NULL) folded, count(*) total FROM interval_segments`,
        )
      ).rows[0];
      console.log("[fold] after:", after);

      for (const a of samples) {
        const folded = await tx
          .select()
          .from(intervalSegments)
          .where(eq(intervalSegments.activityId, a))
          .orderBy(asc(intervalSegments.segmentIndex));
        const exp = expandRestSegments(folded);
        const got = {
          types: exp.map((s) => s.type).join(","),
          ends: JSON.stringify(exp.map((s) => s.timeSeriesEndTime)),
          restStats: JSON.stringify(
            exp.filter((s) => s.type === "REST").map((s) => [s.actualDuration, s.avgHeartRate]),
          ),
        };
        const match =
          got.types === originals[a].types &&
          got.ends === originals[a].ends &&
          got.restStats === originals[a].restStats;
        console.log(`  activity ${a}: round-trip ${match ? "OK" : "MISMATCH"} (${originals[a].types.split(",").length} segs)`);
        ok = ok && match;
      }
      if (!ok) throw new Error("__rollback__");
    });
  } catch (e: any) {
    if (e.message === "__rollback__") {
      console.log("[verify] FAILED — transaction rolled back, NO data changed. Backup kept.");
      throw new Error("round-trip verification failed; transaction rolled back");
    }
    throw e;
  }
  console.log("[done] backfill committed; round-trip verified on all samples.");
  console.log("       Backup table interval_segments_backup_optionb retained — DROP it once satisfied.");
}

runScript({ name: "run_backfill_fold", once: true, db, pool }, main);
