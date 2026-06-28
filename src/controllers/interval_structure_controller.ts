import * as intervalStructureRepo from "../repositories/interval_structure_repository";
import type {
  IntervalStructureHistoryResponseSchema,
  IntervalStructureListResponseSchema,
} from "../schemas/api_schemas";
import type { IGlobalBindings } from "../types/IRouters";
import type { z } from "zod";

type Db = IGlobalBindings["db"];

/** The distinct interval structures the user has used, for filter pickers. */
export function listUsedStructures(db: Db, userId: string) {
  return intervalStructureRepo.listDistinctForUser(db, userId);
}

const toNumber = (v: string | number | null): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

export async function listStructures(
  db: Db,
  userId: string,
): Promise<z.infer<typeof IntervalStructureListResponseSchema>> {
  const rows = await intervalStructureRepo.listDistinctForUser(db, userId);
  const data = rows.map((r) => ({
    id: r.id,
    name: r.name,
    signature: r.signature,
    activityCount: r.activityCount,
    lastDoneAt: toIso(r.lastDoneAt),
  }));
  return { data, meta: { count: data.length } };
}

export async function getStructureHistory(
  db: Db,
  userId: string,
  structureId: number,
): Promise<z.infer<typeof IntervalStructureHistoryResponseSchema>> {
  const rows = await intervalStructureRepo.structureHistory(db, userId, structureId);
  const data = rows.map((r) => ({
    activityId: r.activityId,
    date: r.date.toISOString(),
    title: r.title,
    indoor: r.indoor,
    distance: r.distance,
    movingTime: r.movingTime,
    avgHeartRate: r.avgHeartRate,
    load: toNumber(r.load),
    workRepCount: r.workRepCount,
    avgWorkPaceSecPerKm: toNumber(r.avgWorkPaceSecPerKm),
    fastestWorkPaceSecPerKm: toNumber(r.fastestWorkPaceSecPerKm),
    slowestWorkPaceSecPerKm: toNumber(r.slowestWorkPaceSecPerKm),
    targetWorkPaceSecPerKm: toNumber(r.targetWorkPaceSecPerKm),
    avgWorkHr: toNumber(r.avgWorkHr),
    minWorkHr: toNumber(r.minWorkHr),
    maxWorkHr: toNumber(r.maxWorkHr),
  }));
  return { data, meta: { structureId, count: data.length } };
}
