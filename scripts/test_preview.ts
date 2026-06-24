import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { previewSegments } from "../src/controllers/activity_controller";
import { logger } from "../src/logger";
import * as schema from "../src/schema";
import { getProposedPaceForStructure } from "../src/services/pace_service";

// Validate the unified preview flow end to end, mirroring the app:
//   structure --(/proposed-pace || /parse-intervals)--> paced ExpandedIntervalSet[]
//            --(/preview-segments)--> per-rep segments carrying THOSE SAME paces.
// Confirms the supplied paces flow straight through (segment list == pace view).
// ACTID=505 bun run scripts/test_preview.ts

const ACTID = Number(process.env.ACTID ?? 505);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

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

  const structure = [
    {
      set_reps: 1,
      set_recovery: 0,
      steps: [
        {
          reps: 8,
          work_type: "DISTANCE",
          work_value: 1000,
          recovery_type: "TIME",
          recovery_value: 60,
        },
      ],
    },
  ];

  // Step 1: the paces the app would already hold (from /proposed-pace or /parse-intervals).
  const pacedSets = await getProposedPaceForStructure(
    db,
    user.id,
    user.clerkId,
    structure as any,
  );
  const suppliedPaces = pacedSets.flatMap((s) => s.steps.map((st) => st.target_pace));
  console.log(
    `[preview] supplied paced sets: ${pacedSets.length} set(s), ${suppliedPaces.length} step(s); paces=[${suppliedPaces
      .map((p) => (p != null ? p.toFixed(2) : "null"))
      .join(", ")}]`,
  );

  // Step 2: re-segment with those paced sets — paces must flow straight through.
  const segs = await previewSegments(
    db,
    user.id,
    user.clerkId,
    ACTID,
    pacedSets,
    "LONG_INTERVALS",
    logger,
  );
  const intervals = segs.filter((s) => s.type === "INTERVALS");
  console.log(
    `[preview] id=${ACTID} "${act.title}" -> ${segs.length} segments (${intervals.length} INTERVALS), targetPaces=${intervals.filter((s) => s.targetPace != null).length}/${intervals.length}`,
  );
  for (const s of segs) {
    console.log(
      `  ${s.type.padEnd(10)} end=${s.timeSeriesEndTime}s dur=${Math.round(s.actualDuration ?? 0)}s dist=${Math.round(s.actualDistance ?? 0)}m targetPace=${s.targetPace != null ? s.targetPace.toFixed(2) : "-"}`,
    );
  }

  // Plumbing proof: inject a sentinel pace into every supplied step and confirm
  // it flows verbatim to the segments (i.e. the segment list renders the SAME
  // paces the pace view holds — the whole point of the unification).
  const SENTINEL = 3.5;
  const injected = pacedSets.map((set) => ({
    ...set,
    steps: set.steps.map((st) => ({ ...st, target_pace: SENTINEL })),
  }));
  const segs2 = await previewSegments(
    db,
    user.id,
    user.clerkId,
    ACTID,
    injected,
    "LONG_INTERVALS",
    logger,
  );
  const iv2 = segs2.filter((s) => s.type === "INTERVALS");
  const flowed = iv2.filter((s) => s.targetPace != null && Math.abs(s.targetPace - SENTINEL) < 0.001).length;
  console.log(
    `[preview] sentinel pass: injected target_pace=${SENTINEL} -> ${flowed}/${iv2.length} INTERVALS carry it (${flowed === iv2.length ? "PASS" : "FAIL"})`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error("[preview] fatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
