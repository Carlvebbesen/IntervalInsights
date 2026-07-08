import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseIntervals } from "../src/controllers/analysis_controller";
import { previewSegments } from "../src/controllers/activity_controller";
import { logger } from "../src/logger";
import * as schema from "../src/schema";
import { runScript } from "./_harness";

// In-process replica of the app's "generate from text" (no token / HTTP): parse the
// text into paced sets, then previewSegments on them — does the backend return
// segments? ACTID=505 TEXT="6x800m" bun run scripts/repro_parse_preview.ts

const ACTID = Number(process.env.ACTID ?? 505);
const TEXT = process.env.TEXT ?? "6x800m";
const TYPE = (process.env.TYPE ?? "LONG_INTERVALS") as any;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  const act = (await db.select().from(schema.activities).where(eq(schema.activities.id, ACTID)))[0] as any;
  const user = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, act.userId))
  )[0];

  const sets = await parseIntervals(db, user.id, TEXT, TYPE, logger);
  console.log(`\n[parse] "${TEXT}" -> ${sets.length} set(s)`);
  for (const s of sets) {
    const steps = s.steps
      .map(
        (st: any) =>
          `${st.work_type}:${st.work_value} rest=${st.recovery_value ?? "∅"}(${st.recovery_type ?? "-"}) pace=${st.target_pace ?? "-"}`,
      )
      .join(" | ");
    console.log(`  set_recovery=${s.set_recovery ?? "∅"} steps=[${steps}]`);
  }

  const segs = await previewSegments(db, user.id, ACTID, sets as any, TYPE, logger);
  const iv = segs.filter((x) => x.type === "INTERVALS");
  console.log(`\n[preview] id=${ACTID} "${act.title}" -> ${segs.length} segments, ${iv.length} INTERVALS`);
  for (const s of segs)
    console.log(
      `  ${String(s.type).padEnd(11)} tgt=${s.targetType}:${s.targetValue} dur=${Math.round(s.actualDuration ?? 0)}s dist=${Math.round(s.actualDistance ?? 0)}m`,
    );
}

runScript({ name: "repro_parse_preview", once: false, db, pool }, main);
