import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEditorState } from "../src/controllers/activity_controller";
import { logger } from "../src/logger";
import * as schema from "../src/schema";

// Validate the unified editor-state endpoint end to end (no Strava token → history +
// db-stream path, so it runs free against the local DB):
//   1) structure mode → computes paces AND derives segments from them (one call).
//   2) sets mode (feed mode-1's paced sets back) → paces flow VERBATIM and the derived
//      segments are identical (idempotent), proving the rep-list is the single source.
// ACTID=505 bun run scripts/test_editor_state.ts

const ACTID = Number(process.env.ACTID ?? 505);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

const STRUCTURE = [
  {
    set_reps: 1,
    set_recovery: 0,
    steps: [
      { reps: 8, work_type: "DISTANCE" as const, work_value: 1000, recovery_type: "TIME" as const, recovery_value: 60 },
    ],
  },
];

function ok(label: string, cond: boolean) {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
  return cond;
}

async function main() {
  const act = (
    await db.select().from(schema.activities).where(eq(schema.activities.id, ACTID))
  )[0] as any;
  const user = (
    await db
      .select({ id: schema.users.id, clerkId: schema.users.clerkId })
      .from(schema.users)
      .where(eq(schema.users.id, act.userId))
  )[0];

  // Mode 1 — initial load: structure → paces + segments in ONE call.
  const m1 = await getEditorState(
    db,
    user.id,
    user.clerkId,
    undefined, // no Strava token → history paces + db/intervals streams
    ACTID,
    { structure: STRUCTURE as any, trainingType: "LONG_INTERVALS", includeStreams: false },
    logger,
  );
  const m1Paces = m1.sets.flatMap((s) => s.steps.map((st) => st.target_pace));
  const m1Intervals = m1.segments.filter((s) => s.type === "INTERVALS");
  console.log(
    `[editor-state] mode1 id=${ACTID} "${act.title}" -> ${m1.sets.length} set(s), ${m1.segments.length} segs (${m1Intervals.length} INTERVALS); paces=[${m1Paces.map((p) => (p != null ? p.toFixed(2) : "null")).join(", ")}]`,
  );

  // Mode 2 — re-derive: feed the paced sets back. Paces must flow verbatim and the
  // segments must be identical (the derive is deterministic on a fixed rep-list).
  const m2 = await getEditorState(
    db,
    user.id,
    user.clerkId,
    undefined,
    ACTID,
    { sets: m1.sets, trainingType: "LONG_INTERVALS", includeStreams: false },
    logger,
  );

  let allPass = true;
  allPass = ok("mode2 returns the supplied sets verbatim", JSON.stringify(m2.sets) === JSON.stringify(m1.sets)) && allPass;
  allPass = ok("mode2 segment count == mode1", m2.segments.length === m1.segments.length) && allPass;
  allPass = ok("mode2 segments identical to mode1 (deterministic derive)", JSON.stringify(m2.segments) === JSON.stringify(m1.segments)) && allPass;
  allPass = ok("streams null when includeStreams:false", m1.streams === null && m2.streams === null) && allPass;

  // Sentinel: inject a unique pace and confirm it rides through to every INTERVALS segment.
  const SENTINEL = 3.5;
  const injected = m1.sets.map((set) => ({ ...set, steps: set.steps.map((st) => ({ ...st, target_pace: SENTINEL })) }));
  const m3 = await getEditorState(
    db,
    user.id,
    user.clerkId,
    undefined,
    ACTID,
    { sets: injected, trainingType: "LONG_INTERVALS", includeStreams: false },
    logger,
  );
  const iv3 = m3.segments.filter((s) => s.type === "INTERVALS");
  const flowed = iv3.filter((s) => s.targetPace != null && Math.abs(s.targetPace - SENTINEL) < 0.001).length;
  allPass = ok(`sentinel pace ${SENTINEL} flows to all INTERVALS (${flowed}/${iv3.length})`, iv3.length > 0 && flowed === iv3.length) && allPass;

  console.log(`[editor-state] ${allPass ? "ALL PASS" : "SOME FAILED"}`);
  await pool.end();
  if (!allPass) process.exit(1);
}

main().catch(async (e) => {
  console.error("[editor-state] fatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
