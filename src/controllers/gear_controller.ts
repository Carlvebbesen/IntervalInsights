import type { z } from "zod";
import { type GearDto, toGearDto } from "../dtos/gear_dto";
import { AppError } from "../error";
import type { GearListFilters } from "../repositories/gear_repository";
import * as gearRepo from "../repositories/gear_repository";
import type { GearSurface, InsertGear, TrainingBucket } from "../schema";
import type { CreateGearSchema, UpdateGearSchema } from "../schemas/api_schemas";
import {
  type GearSyncResult,
  KNOWN_SHOE_BRANDS,
  syncUserGearFromStrava,
} from "../services/gear_strava_service";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];
type CreateGearInput = z.infer<typeof CreateGearSchema>;
type UpdateGearInput = z.infer<typeof UpdateGearSchema>;

const BUCKETS: TrainingBucket[] = ["EASY", "LONG", "INTERVALS"];

/** Set/clear the (bucket, surface) defaults for a gear from the create/edit toggles. */
async function applyDefaultToggles(
  db: Db,
  userId: string,
  gearId: number,
  surface: GearSurface,
  toggles: { defaultEasy?: boolean; defaultLong?: boolean; defaultIntervals?: boolean },
): Promise<void> {
  const wanted: Record<TrainingBucket, boolean | undefined> = {
    EASY: toggles.defaultEasy,
    LONG: toggles.defaultLong,
    INTERVALS: toggles.defaultIntervals,
  };
  for (const bucket of BUCKETS) {
    const want = wanted[bucket];
    if (want === undefined) continue;
    if (want) {
      await gearRepo.setDefault(db, userId, bucket, surface, gearId);
    } else if ((await gearRepo.findDefaultGearId(db, userId, bucket, surface)) === gearId) {
      await gearRepo.clearDefault(db, userId, bucket, surface);
    }
  }
}

/** Build a full GearDto (with default flags + per-type counts) for one gear. */
async function buildGearDto(db: Db, userId: string, gearId: number): Promise<GearDto> {
  const gear = await gearRepo.findByIdForUser(db, userId, gearId);
  if (!gear) throw new AppError(404, "Gear not found");
  const [defaults, countRows] = await Promise.all([
    gearRepo.getDefaults(db, userId),
    gearRepo.trainingTypeCountsByGear(db, userId),
  ]);
  const buckets = new Set(defaults.filter((d) => d.gearId === gearId).map((d) => d.bucket));
  const counts: Record<string, number> = {};
  for (const row of countRows) {
    if (row.gearId === gearId && row.trainingType) {
      counts[row.trainingType] = (counts[row.trainingType] ?? 0) + Number(row.count);
    }
  }
  return toGearDto(gear, { defaultBuckets: buckets, trainingTypeCounts: counts });
}

export async function listGears(
  db: Db,
  userId: string,
  filters: GearListFilters,
): Promise<{ data: GearDto[] }> {
  const [gearsList, defaults, countRows] = await Promise.all([
    gearRepo.listForUser(db, userId, filters),
    gearRepo.getDefaults(db, userId),
    gearRepo.trainingTypeCountsByGear(db, userId),
  ]);

  const defaultBuckets = new Map<number, Set<TrainingBucket>>();
  for (const d of defaults) {
    const s = defaultBuckets.get(d.gearId) ?? new Set<TrainingBucket>();
    s.add(d.bucket);
    defaultBuckets.set(d.gearId, s);
  }

  const counts = new Map<number, Record<string, number>>();
  for (const row of countRows) {
    if (row.gearId == null || !row.trainingType) continue;
    const m = counts.get(row.gearId) ?? {};
    m[row.trainingType] = (m[row.trainingType] ?? 0) + Number(row.count);
    counts.set(row.gearId, m);
  }

  return {
    data: gearsList.map((g) =>
      toGearDto(g, {
        defaultBuckets: defaultBuckets.get(g.id),
        trainingTypeCounts: counts.get(g.id),
      }),
    ),
  };
}

export async function createGear(db: Db, userId: string, input: CreateGearInput): Promise<GearDto> {
  const gear = await gearRepo.create(db, userId, {
    gearType: input.gearType ?? "SHOES",
    brand: input.brand ?? null,
    model: input.model,
    nickname: input.nickname ?? null,
    surface: input.surface,
  });
  await applyDefaultToggles(db, userId, gear.id, gear.surface, input);
  return buildGearDto(db, userId, gear.id);
}

export async function updateGear(
  db: Db,
  userId: string,
  id: number,
  input: UpdateGearInput,
): Promise<GearDto> {
  const existing = await gearRepo.findByIdForUser(db, userId, id);
  if (!existing) throw new AppError(404, "Gear not found");

  const updates: Partial<InsertGear> = {};
  if (input.brand !== undefined) updates.brand = input.brand;
  if (input.model !== undefined) updates.model = input.model;
  if (input.nickname !== undefined) updates.nickname = input.nickname;
  if (input.surface !== undefined) updates.surface = input.surface;
  if (input.isActive !== undefined) {
    updates.isActive = input.isActive;
    updates.retiredAt = input.isActive ? null : (existing.retiredAt ?? new Date());
  }
  if (Object.keys(updates).length > 0) {
    await gearRepo.update(db, userId, id, updates);
  }

  const newSurface = input.surface ?? existing.surface;
  if (input.isActive === false) {
    // Retired gear can't be a default anywhere.
    await gearRepo.clearDefaultsForGear(db, userId, id);
  } else {
    if (input.surface && input.surface !== existing.surface) {
      // Defaults are surface-keyed; drop stale-surface entries before re-applying.
      await gearRepo.clearDefaultsForGear(db, userId, id);
    }
    await applyDefaultToggles(db, userId, id, newSurface, input);
  }

  return buildGearDto(db, userId, id);
}

export function getBrands(): { brands: string[] } {
  return { brands: [...KNOWN_SHOE_BRANDS] };
}

export function syncFromStrava(
  db: Db,
  userId: string,
  accessToken: string,
): Promise<GearSyncResult> {
  return syncUserGearFromStrava(db, userId, accessToken);
}
