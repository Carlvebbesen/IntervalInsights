import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, eq, gt } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { intervalSegments } from "../src/schema";
import { foldRestSegments, expandRestSegments } from "../src/services/segment_fold_service";
import { runScript } from "./_harness";

// Inserts a folded work+rest set against the REAL DB inside a transaction that is
// ALWAYS rolled back, then reads it back and expands — proves the schema columns
// + fold/expand round-trip against Postgres without mutating any data.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

async function main() {
  const act = (await db.select().from(schema.activities).limit(1))[0] as any;
  if (!act) throw new Error("no activity to borrow an id from");

  const expanded = [
    { activityId: act.id, segmentIndex: 0, setGroupIndex: 1, type: "INTERVALS" as const, targetType: "distance" as const, targetValue: 1000, targetPace: 3.5, timeSeriesEndTime: 100, actualDistance: 1000, actualDuration: 300, avgHeartRate: 160 },
    { activityId: act.id, segmentIndex: 1, setGroupIndex: 1, type: "REST" as const, targetType: "time" as const, targetValue: 60, targetPace: null, timeSeriesEndTime: 140, actualDistance: 80, actualDuration: 40, avgHeartRate: 138 },
  ];

  let ok = true;
  try {
    await db.transaction(async (tx) => {
      const folded = foldRestSegments(expanded);
      console.log(`[fold] ${expanded.length} expanded -> ${folded.length} stored (no REST row: ${!folded.some((s) => s.type === "REST")})`);
      await tx.insert(intervalSegments).values(folded.map((s) => ({ ...s, segmentIndex: 9000 + s.segmentIndex })));
      const back = await tx
        .select()
        .from(intervalSegments)
        .where(and(eq(intervalSegments.activityId, act.id), gt(intervalSegments.segmentIndex, 8999)))
        .orderBy(asc(intervalSegments.segmentIndex));
      const work = back[0];
      ok = ok && work.recoveryEndTime === 140 && work.recoveryDuration === 40 && work.recoveryAvgHeartRate === 138;
      console.log(`[db]  read folded work row: recoveryEndTime=${work.recoveryEndTime} recoveryDuration=${work.recoveryDuration} recoveryAvgHr=${work.recoveryAvgHeartRate}`);
      const restored = expandRestSegments(back);
      const types = restored.map((s) => s.type);
      ok = ok && types.join(",") === "INTERVALS,REST";
      console.log(`[expand] folded -> ${types.join(", ")} (rest end=${restored[1].timeSeriesEndTime}, dur=${restored[1].actualDuration})`);
      throw new Error("__rollback__");
    });
  } catch (e: any) {
    if (e.message !== "__rollback__") throw e;
  }
  console.log(`[verify] ${ok ? "ALL PASS" : "FAILED"} (transaction rolled back — no data changed)`);
  if (!ok) throw new Error("fold round-trip assertions failed");
}

runScript({ name: "verify_fold_roundtrip", once: false, db, pool }, main);
