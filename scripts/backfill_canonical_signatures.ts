import { asc, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { InsertIntervalSegment } from "../src/schema";
import * as schema from "../src/schema";
import { activities, intervalSegments, intervalStructures } from "../src/schema";
import {
  generateIntervalSignature,
  generateStructureName,
  mapSegmentsToComponents,
} from "../src/services/interval_structure_service";
import { runScript } from "./_harness";

// Recomputes canonical signatures for every activity that is linked to an
// interval structure, re-points it at the find-or-create canonical structure,
// refreshes kept structures' names, and deletes the resulting orphans.
//
// Distance-only (no GPS venue confirmation): the backfill runs offline against
// stored segments. Measured venue laps still snap by distance (that's what
// produced the junk rows); round-number venue laps that would need GPS are rare
// and get their token on the next re-analysis instead.
//
// DRY_RUN=1 prints the old→new merge map and touches nothing.

const DRY_RUN = process.env.DRY_RUN === "1";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

type Plan = {
  activityId: number;
  oldStructureId: number;
  newSignature: string;
  newName: string;
};

async function main() {
  console.log(`[sigcanon] dryRun=${DRY_RUN}`);

  const structures = await db
    .select({
      id: intervalStructures.id,
      name: intervalStructures.name,
      signature: intervalStructures.signature,
    })
    .from(intervalStructures);
  const structureById = new Map(structures.map((s) => [s.id, s]));
  const sigToId = new Map<string, number>();
  for (const s of structures) if (s.signature) sigToId.set(s.signature, s.id);

  const linkedActivities = await db
    .select({ id: activities.id, structureId: activities.intervalStructureId })
    .from(activities)
    .where(isNotNull(activities.intervalStructureId))
    .orderBy(asc(activities.id));

  const activityIds = linkedActivities.map((a) => a.id);
  const segRows = activityIds.length
    ? await db
        .select({
          activityId: intervalSegments.activityId,
          type: intervalSegments.type,
          targetType: intervalSegments.targetType,
          targetValue: intervalSegments.targetValue,
        })
        .from(intervalSegments)
        .where(inArray(intervalSegments.activityId, activityIds))
        .orderBy(asc(intervalSegments.segmentIndex))
    : [];
  const segsByActivity = new Map<number, InsertIntervalSegment[]>();
  for (const s of segRows) {
    const list = segsByActivity.get(s.activityId) ?? [];
    list.push(s as unknown as InsertIntervalSegment);
    segsByActivity.set(s.activityId, list);
  }

  const plans: Plan[] = [];
  let emptyShape = 0;
  for (const a of linkedActivities) {
    if (a.structureId == null) continue;
    const components = mapSegmentsToComponents(segsByActivity.get(a.id) ?? []);
    const newSignature = generateIntervalSignature(components);
    if (newSignature === "") {
      // No canonical work shape (all custom/zero, or segments never stored).
      // Leave the activity on its current structure and report it.
      emptyShape += 1;
      continue;
    }
    plans.push({
      activityId: a.id,
      oldStructureId: a.structureId,
      newSignature,
      newName: generateStructureName(components),
    });
  }

  // Target structure per canonical signature: an existing row or a to-create one.
  const canonicalNameBySig = new Map<string, string>();
  for (const p of plans) canonicalNameBySig.set(p.newSignature, p.newName);
  const sigsNeedingCreate = [...canonicalNameBySig.keys()].filter((sig) => !sigToId.has(sig));

  // Merge map for reporting: oldStructureId → { newSig, activityCount }.
  const moves = new Map<number, Map<string, number>>();
  for (const p of plans) {
    const byNew = moves.get(p.oldStructureId) ?? new Map<string, number>();
    byNew.set(p.newSignature, (byNew.get(p.newSignature) ?? 0) + 1);
    moves.set(p.oldStructureId, byNew);
  }

  console.log(`\n[sigcanon] === merge map (${plans.length} linked activities) ===`);
  for (const [oldId, byNew] of [...moves.entries()].sort((a, b) => a[0] - b[0])) {
    const old = structureById.get(oldId);
    console.log(`  #${oldId} "${old?.name}" [${old?.signature}]`);
    for (const [sig, n] of byNew) {
      const dest = sigToId.has(sig) ? `existing #${sigToId.get(sig)}` : "NEW";
      const marker = old?.signature === sig ? " (unchanged)" : "";
      console.log(`      → ${dest} [${sig}] "${canonicalNameBySig.get(sig)}" ×${n}${marker}`);
    }
  }
  console.log(
    `\n[sigcanon] structures before=${structures.length} newToCreate=${sigsNeedingCreate.length} ` +
      `emptyShapeActivities=${emptyShape}`,
  );

  if (DRY_RUN) {
    console.log("[sigcanon] dry run — no writes");
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS interval_structures_backup_sigcanon AS TABLE interval_structures`,
  );
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS activities_structure_backup_sigcanon AS
        SELECT id, interval_structure_id FROM activities WHERE interval_structure_id IS NOT NULL`,
  );

  // Create missing canonical structures, filling sigToId.
  for (const sig of sigsNeedingCreate) {
    const [created] = await db
      .insert(intervalStructures)
      .values({ name: canonicalNameBySig.get(sig) ?? sig, signature: sig })
      .onConflictDoNothing({ target: intervalStructures.signature })
      .returning({ id: intervalStructures.id });
    if (created) {
      sigToId.set(sig, created.id);
    } else {
      const [existing] = await db
        .select({ id: intervalStructures.id })
        .from(intervalStructures)
        .where(sql`${intervalStructures.signature} = ${sig}`)
        .limit(1);
      if (existing) sigToId.set(sig, existing.id);
    }
  }

  // Re-point activities whose target differs from their current structure.
  let repointed = 0;
  for (const p of plans) {
    const targetId = sigToId.get(p.newSignature);
    if (targetId == null || targetId === p.oldStructureId) continue;
    await db
      .update(activities)
      .set({ intervalStructureId: targetId })
      .where(sql`${activities.id} = ${p.activityId}`);
    repointed += 1;
  }

  // Refresh REUSED (pre-existing) canonical structures' names to the canonical
  // form. Freshly-created rows already carry it, so skip anything not in the
  // initial snapshot.
  let renamed = 0;
  for (const [sig, name] of canonicalNameBySig) {
    const id = sigToId.get(sig);
    if (id == null) continue;
    const current = structureById.get(id);
    if (!current || current.name === name) continue;
    await db
      .update(intervalStructures)
      .set({ name })
      .where(sql`${intervalStructures.id} = ${id}`);
    renamed += 1;
  }

  // Delete orphans (no activity references them).
  const deleted = await db.execute(sql`
    DELETE FROM interval_structures
    WHERE id NOT IN (
      SELECT DISTINCT interval_structure_id FROM activities WHERE interval_structure_id IS NOT NULL
    )
    RETURNING id`);
  const deletedCount = Array.isArray(deleted) ? deleted.length : (deleted.rowCount ?? 0);

  const [{ n: after }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intervalStructures);
  console.log(
    `[sigcanon] applied. repointed=${repointed} created=${sigsNeedingCreate.length} ` +
      `renamed=${renamed} orphansDeleted=${deletedCount} structuresAfter=${after}`,
  );
}

// A dry run must NOT record a run in script_runs — otherwise the `once` guard
// would treat the subsequent real apply as already-done and skip it.
if (DRY_RUN) {
  main()
    .catch((err) => {
      console.error("[sigcanon] dry run failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
} else {
  runScript({ name: "backfill_canonical_signatures", once: true, db, pool }, main);
}
