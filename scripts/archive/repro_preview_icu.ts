import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { previewSegments } from "../src/controllers/activity_controller";
import { logger } from "../src/logger";
import * as schema from "../src/schema";
import { generateCompleteIntervalSet } from "../src/services/utils";
import { runScript } from "./_harness";

// Characterize "generate segments from text" (previewSegments): does the returned
// INTERVALS count match the USER's typed structure across activities?
// bun run scripts/repro_preview_icu.ts

const t = (reps: number, w: number, r: number) => ({ reps, work_type: "TIME", work_value: w, recovery_type: "TIME", recovery_value: r });
const d = (reps: number, w: number, r: number) => ({ reps, work_type: "DISTANCE", work_value: w, recovery_type: "TIME", recovery_value: r });

const CASES: Record<number, any[]> = {
  505: [{ set_reps: 1, set_recovery: 0, steps: [d(8, 1000, 90)] }], // non-icu control
  510: [{ set_reps: 3, set_recovery: 60, steps: [d(1, 3000, 120), d(1, 2000, 60), d(1, 1000, 60)] }], // non-icu control
  620: [{ set_reps: 4, set_recovery: 60, steps: [t(1, 180, 60), t(1, 120, 60), t(1, 60, 60)] }],
  622: [{ set_reps: 5, set_recovery: 60, steps: [t(1, 180, 60), t(1, 120, 60), t(1, 60, 60)] }],
  626: [{ set_reps: 1, set_recovery: 0, steps: [d(10, 1000, 90)] }],
  509: [{ set_reps: 1, set_recovery: 0, steps: [t(20, 45, 15)] }],
  608: [{ set_reps: 1, set_recovery: 0, steps: [t(20, 45, 15)] }],
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  const ids = process.env.ACTID ? [Number(process.env.ACTID)] : Object.keys(CASES).map(Number);
  console.log(`\nid    icu?  typed  returned  verdict`);
  for (const id of ids) {
    const act = (await db.select().from(schema.activities).where(eq(schema.activities.id, id)))[0] as any;
    if (!act) { console.log(`${id}: not found`); continue; }
    const user = (await db.select({ id: schema.users.id, clerkId: schema.users.clerkId }).from(schema.users).where(eq(schema.users.id, act.userId)))[0];
    const sets = generateCompleteIntervalSet(CASES[id] as any);
    const expected = sets.reduce((n, s) => n + s.steps.length, 0);
    try {
      const segs = await previewSegments(db, user.id, user.clerkId, id, sets as any, "LONG_INTERVALS", logger);
      const got = segs.filter((s) => s.type === "INTERVALS").length;
      console.log(`${String(id).padEnd(5)} ${(act.intervalsIcuId ? "yes" : "no ").padEnd(4)}  ${String(expected).padStart(5)}  ${String(got).padStart(8)}  ${got === expected ? "OK" : `WRONG (${got}!=${expected})`}`);
    } catch (e) {
      console.log(`${id}: error ${e instanceof Error ? e.message : e}`);
    }
  }
}

runScript({ name: "repro_preview_icu", once: false, db, pool }, main);
