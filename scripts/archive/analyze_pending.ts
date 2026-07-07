import { sleep } from "bun";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getStravaAccessTokens } from "../src/middlewares/strava_middleware";
import * as schema from "../src/schema";
import { startAnalysis } from "../src/services/analysis_service";
import { runScript } from "./_harness";

/**
 * Run the REAL analyze graph on every `pending` activity (or IDS=...) and report
 * the classified type + how many reps segmentation found vs the title's structure.
 * Makes real gpt-4o-mini calls. `pending` is not in SKIP_START_STATUSES, so no
 * status reset is needed. Run: bun run scripts/analyze_pending.ts
 */

const OUT =
  process.env.OUT ??
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps/PENDING_ANALYSIS.md";
const DELAY_MS = Number(process.env.DELAY_MS ?? 500);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

function structureReps(structure: any): number | null {
  if (!Array.isArray(structure) || structure.length === 0) return null;
  let n = 0;
  for (const set of structure)
    for (const step of set.steps ?? []) n += (set.set_reps ?? 1) * (step.reps ?? 1);
  return n || null;
}

async function main() {
  const ids = process.env.IDS
    ? process.env.IDS.split(",").map(Number)
    : (
        await db
          .select({ id: schema.activities.id })
          .from(schema.activities)
          .where(eq(schema.activities.analysisStatus, "pending"))
          .orderBy(asc(schema.activities.id))
      ).map((r) => r.id);

  console.log(`[pending] analyzing ${ids.length} activities`);
  const tokenCache = new Map<string, string>();
  const rows: any[] = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const act = (
      await db.select().from(schema.activities).where(eq(schema.activities.id, id))
    )[0] as any;
    if (!act) continue;
    const clerkId = (
      await db
        .select({ clerkId: schema.users.clerkId })
        .from(schema.users)
        .where(eq(schema.users.id, act.userId))
    )[0]?.clerkId as string | undefined;
    let token = "";
    if (clerkId) {
      if (!tokenCache.has(clerkId)) {
        try {
          tokenCache.set(clerkId, (await getStravaAccessTokens(clerkId)).access_token);
        } catch {
          tokenCache.set(clerkId, "");
        }
      }
      token = tokenCache.get(clerkId) ?? "";
    }

    const t0 = Date.now();
    try {
      await startAnalysis(db, token, id, act.stravaActivityId ?? null, act.userId);
    } catch (e) {
      console.log(`[pending] ${id} threw ${e instanceof Error ? e.message : e}`);
    }

    const fresh = (
      await db
        .select({
          draft: schema.activities.draftAnalysisResult,
          status: schema.activities.analysisStatus,
        })
        .from(schema.activities)
        .where(eq(schema.activities.id, id))
    )[0] as any;
    const draft = fresh?.draft ?? {};
    const segs = Array.isArray(draft.proposedSegments) ? draft.proposedSegments : [];
    const segReps = segs.filter((s: any) => s.type === "INTERVALS").length;
    const rec = {
      id,
      src: act.intervalsIcuId ? "icu" : act.stravaActivityId != null ? "strava" : "none",
      title: act.title,
      type: draft.training_type ?? null,
      conf: draft.confidence_score ?? null,
      structReps: structureReps(draft.structure),
      segReps,
      totalSegs: segs.length,
      status: fresh?.status,
      reasoning: draft.classification_reasoning ?? null,
    };
    rows.push(rec);
    console.log(
      `[pending] ${i + 1}/${ids.length} id=${id} [${rec.src}] "${String(act.title).slice(0, 26)}" -> ${rec.type} (${rec.conf}) structReps=${rec.structReps} segReps=${rec.segReps}/${rec.totalSegs} ${Date.now() - t0}ms`,
    );
    if (i < ids.length - 1) await sleep(DELAY_MS);
  }

  const lines = [
    "# Pending-activity analysis — full graph re-run (current code)",
    "",
    `${rows.length} activities. structReps = reps the LLM read from the title; segReps = INTERVALS segments the segmenter found.`,
    "",
    "| id | src | title | type | conf | structReps | segReps/total | reasoning |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.src} | ${String(r.title).replace(/\|/g, "/").slice(0, 30)} | ${r.type} | ${r.conf} | ${r.structReps ?? "-"} | ${r.segReps}/${r.totalSegs} | ${String(r.reasoning ?? "").replace(/\|/g, "/").slice(0, 70)} |`,
    ),
  ];
  await Bun.write(OUT, lines.join("\n"));
  console.log(`[pending] done. report=${OUT}`);
}

runScript({ name: "analyze_pending", once: false, db, pool }, main);
