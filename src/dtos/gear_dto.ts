import type { z } from "zod";
import type { GearDao, GearSummaryDao } from "../repositories/gear_repository";
import type { TrainingBucket } from "../schema";
import type { GearSchema, GearSummarySchema } from "../schemas/api_schemas";

export type GearDto = z.infer<typeof GearSchema>;
export type GearSummaryDto = z.infer<typeof GearSummarySchema>;

/** nickname → "brand model" → model. The label shown on badges and lists. */
export function gearDisplayName(g: {
  nickname: string | null;
  brand: string | null;
  model: string;
}): string {
  if (g.nickname?.trim()) return g.nickname.trim();
  const joined = [g.brand, g.model].filter(Boolean).join(" ").trim();
  return joined || g.model;
}

export function toGearSummaryDto(dao: GearSummaryDao): GearSummaryDto {
  return {
    id: dao.id,
    brand: dao.brand,
    model: dao.model,
    nickname: dao.nickname,
    displayName: gearDisplayName(dao),
    surface: dao.surface,
    isActive: dao.isActive,
  };
}

export interface GearDtoExtras {
  /** Buckets this gear is the default for (on its own surface). */
  defaultBuckets?: Set<TrainingBucket>;
  trainingTypeCounts?: Record<string, number>;
}

export function toGearDto(dao: GearDao, extras: GearDtoExtras = {}): GearDto {
  const distanceMeters = dao.baselineDistanceMeters + dao.maintainedDistanceMeters;
  const defaults = extras.defaultBuckets ?? new Set<TrainingBucket>();
  return {
    id: dao.id,
    gearType: dao.gearType,
    brand: dao.brand,
    model: dao.model,
    nickname: dao.nickname,
    displayName: gearDisplayName(dao),
    surface: dao.surface,
    isActive: dao.isActive,
    retiredAt: dao.retiredAt?.toISOString() ?? null,
    stravaGearId: dao.stravaGearId,
    baselineDistanceMeters: dao.baselineDistanceMeters,
    baselineDate: dao.baselineDate?.toISOString() ?? null,
    maintainedDistanceMeters: dao.maintainedDistanceMeters,
    distanceMeters,
    distanceKm: distanceMeters / 1000,
    activityCount: dao.activityCount,
    isDefaultEasy: defaults.has("EASY"),
    isDefaultLong: defaults.has("LONG"),
    isDefaultIntervals: defaults.has("INTERVALS"),
    isDefaultRace: defaults.has("RACE"),
    trainingTypeCounts: extras.trainingTypeCounts ?? {},
    createdAt: dao.createdAt.toISOString(),
  };
}
