import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getLaps } from "../src/controllers/activity_controller";
import * as schema from "../src/schema";

/**
 * Verify the LIVE proposed interval boundaries against ground truth — NOT just
 * the rep count, but PLACEMENT: each proposed INTERVALS segment's measured
 * length (actualDuration for TIME reps / actualDistance for DISTANCE reps, both
 * computed from the real stream at analysis time) vs the prescribed per-rep
 * value; work-vs-rest speed separation; and the warmup end (first interval
 * start) vs the first high-effort device lap. Reads the persisted draft — no LLM.
 * Run: bun run scripts/verify_boundaries.ts
 */

const IDS = process.env.IDS
  ? process.env.IDS.split(",").map(Number)
  : [503, 617, 505, 510, 619, 613, 504, 623, 629, 626];
const OUT =
  process.env.OUT ??
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps/BOUNDARY_VERIFICATION.md";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

function prescribedReps(structure: any): { type: string; value: number }[] {
  const out: { type: string; value: number }[] = [];
  if (!Array.isArray(structure)) return out;
  for (const set of structure) {
    for (let s = 0; s < (set.set_reps ?? 1); s++) {
      for (const step of set.steps ?? []) {
        for (let r = 0; r < (step.reps ?? 1); r++) {
          out.push({ type: step.work_type, value: step.work_value });
        }
      }
    }
  }
  return out;
}

const spd = (s: any) => (s.actualDuration > 0 ? s.actualDistance / s.actualDuration : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const lines: string[] = ["# Live boundary verification (placement + count vs ground truth)", ""];
  for (const id of IDS) {
    const act = (
      await db.select().from(schema.activities).where(eq(schema.activities.id, id))
    )[0] as any;
    if (!act) {
      console.log(`[verify] ${id} not found`);
      continue;
    }
    const clerkId = (
      await db
        .select({ clerkId: schema.users.clerkId })
        .from(schema.users)
        .where(eq(schema.users.id, act.userId))
    )[0]?.clerkId as string;
    const draft: any = act.draftAnalysisResult ?? {};
    const segs: any[] = Array.isArray(draft.proposedSegments)
      ? [...draft.proposedSegments].sort((a, b) => a.segmentIndex - b.segmentIndex)
      : [];
    const pres = prescribedReps(draft.structure);
    const intervals = segs.filter((s) => s.type === "INTERVALS");
    const rests = segs.filter((s) => s.type === "REST" || s.type === "ACTIVE_REST");
    const warmup = segs.find((s) => s.type === "WARMUP");
    const workSpeed = mean(intervals.map(spd));
    const restSpeed = mean(rests.map(spd));

    // per-rep length vs prescribed (positional, both in order)
    const deltas = intervals.map((s, i) => {
      const p = pres[i];
      if (!p) return null;
      const actual = p.type === "DISTANCE" ? s.actualDistance : s.actualDuration;
      return { target: p.value, type: p.type, actual: Math.round(actual), pct: actual ? Math.round((Math.abs(actual - p.value) / p.value) * 100) : null };
    });
    const within15 = deltas.filter((d) => d && d.pct != null && d.pct <= 15).length;

    // ground truth: first high-effort device lap start (laid contiguously by moving_time)
    let firstWorkLapStart: number | null = null;
    let workLapCount: number | null = null;
    try {
      const laps = await getLaps(db, act.userId, clerkId, id);
      const maxSp = Math.max(0, ...laps.map((l: any) => l.average_speed ?? 0));
      let cum = 0;
      let wc = 0;
      for (const l of laps as any[]) {
        const isWork = maxSp > 0 && (l.average_speed ?? 0) >= 0.75 * maxSp;
        if (isWork) {
          wc++;
          if (firstWorkLapStart === null) firstWorkLapStart = cum;
        }
        cum += l.moving_time ?? l.elapsed_time ?? 0;
      }
      workLapCount = wc;
    } catch (e) {
      // lap fetch best-effort
    }

    const countOk = pres.length > 0 && intervals.length === pres.length;
    const sep = restSpeed > 0 ? r1(workSpeed / restSpeed) : "∞";
    const verdict = `id=${id} "${String(act.title).slice(0, 22)}" type=${draft.training_type} | count: ${intervals.length} INTERVALS vs ${pres.length} prescribed ${countOk ? "✓" : "✗"} | warmupEnd=${warmup?.timeSeriesEndTime ?? "-"}s (firstWorkLap≈${firstWorkLapStart ?? "?"}s, workLaps=${workLapCount ?? "?"}) | work=${r1(workSpeed)} rest=${r1(restSpeed)} m/s (${sep}x) | repLen within15%: ${within15}/${intervals.length}`;
    console.log(`[verify] ${verdict}`);
    const repStr = deltas
      .slice(0, 12)
      .map((d) => (d ? `${d.actual}${d.type === "DISTANCE" ? "m" : "s"}(${d.pct}%)` : "·"))
      .join(" ");
    console.log(`         target=${pres[0]?.value}${pres[0]?.type === "DISTANCE" ? "m" : "s"} actual: ${repStr}${intervals.length > 12 ? " …" : ""}`);
    lines.push(`- ${verdict}`, `  - reps (target ${pres[0]?.value}${pres[0]?.type === "DISTANCE" ? "m" : "s"}): ${repStr}${intervals.length > 12 ? " …" : ""}`);
  }
  await Bun.write(OUT, lines.join("\n"));
  console.log(`[verify] report=${OUT}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error("[verify] fatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
