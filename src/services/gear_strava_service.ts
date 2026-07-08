import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { logger } from "../logger";
import * as gearRepo from "../repositories/gear_repository";
import {
  activities,
  type GearSurface,
  type GearType,
  gearContextForActivity,
  STRAVA_GEAR_SPORT_TYPES,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";
import { stravaApiService } from "./strava_api_service";

type Db = IGlobalBindings["db"];

/** Curated shoe brands offered in the create form (free-text "Other" still allowed). */
export const KNOWN_SHOE_BRANDS = [
  "Nike",
  "Adidas",
  "ASICS",
  "Brooks",
  "Hoka",
  "Saucony",
  "New Balance",
  "On",
  "Mizuno",
  "Salomon",
  "Altra",
  "Puma",
  "Under Armour",
  "Topo Athletic",
  "Inov-8",
  "La Sportiva",
  "Merrell",
  "Scott",
  "Craft",
  "Reebok",
  "Skechers",
  "Newton",
  "Karhu",
] as const;

/** Curated road/gravel/MTB brands offered in the create form (free-text "Other" still allowed). */
export const KNOWN_BIKE_BRANDS = [
  "Trek",
  "Specialized",
  "Canyon",
  "Giant",
  "Cannondale",
  "Scott",
  "Cervélo",
  "BMC",
  "Bianchi",
  "Pinarello",
  "Cube",
  "Orbea",
  "Felt",
  "Ridley",
  "Colnago",
  "Wilier",
  "Merida",
  "Santa Cruz",
  "Focus",
  "Rose",
  "Factor",
  "Salsa",
  "Lauf",
  "3T",
  "Van Rysel",
  "Ribble",
  "Look",
  "Argon 18",
] as const;

/** Curated cross-country ski brands offered in the create form (free-text "Other" still allowed). */
export const KNOWN_XC_SKI_BRANDS = [
  "Fischer",
  "Atomic",
  "Salomon",
  "Rossignol",
  "Madshus",
  "Peltonen",
  "Yoko",
  "Kästle",
  "Åsnes",
  "One Way",
] as const;

/** Curated brand list per gear type, served by `GET /gear/brands?gearType=`. */
export function brandsForGearType(gearType: GearType): readonly string[] {
  switch (gearType) {
    case "BICYCLE":
      return KNOWN_BIKE_BRANDS;
    case "SKIS":
      return KNOWN_XC_SKI_BRANDS;
    default:
      return KNOWN_SHOE_BRANDS;
  }
}

/** Split a Strava gear name into a known brand + model (longest brand prefix
 * wins), matching against the brand list for the gear type. */
export function parseBrandModel(
  name: string | null | undefined,
  brands: readonly string[] = KNOWN_SHOE_BRANDS,
  fallbackModel = "Shoe",
): {
  brand: string | null;
  model: string;
} {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { brand: null, model: fallbackModel };
  const lower = trimmed.toLowerCase();
  const byLength = [...brands].sort((a, b) => b.length - a.length);
  for (const brand of byLength) {
    const bl = brand.toLowerCase();
    if (lower === bl) return { brand, model: brand };
    if (lower.startsWith(`${bl} `)) {
      return { brand, model: trimmed.slice(brand.length).trim() || brand };
    }
  }
  return { brand: null, model: trimmed };
}

/** Per-gear-type brand list + model fallback for `parseBrandModel`. */
function brandParseOptions(gearType: GearType): {
  brands: readonly string[];
  fallbackModel: string;
} {
  return gearType === "BICYCLE"
    ? { brands: KNOWN_BIKE_BRANDS, fallbackModel: "Bike" }
    : { brands: KNOWN_SHOE_BRANDS, fallbackModel: "Shoe" };
}

/** Seed a bike's surface from Strava's `frame_type` (1=MTB, 3=road); gravel is
 * not distinguishable from the profile, so everything else defaults to ROAD. */
function surfaceFromFrameType(frameType: number | undefined): GearSurface {
  return frameType === 1 ? "MTB" : "ROAD";
}

export interface GearSyncResult {
  created: number;
  updated: number;
  linked: number;
}

/**
 * Import/refresh a single user's shoes AND bikes from Strava and link their
 * activities. Source of truth for both the in-app "Sync from Strava" button and
 * the all-users backfill script. New gear is created with a Strava-distance
 * baseline anchored at now (so existing activities, already inside that number,
 * aren't double-counted); existing gear is resynced (baseline refreshed +
 * post-baseline total recomputed). Skis have no Strava gear (manual only).
 */
export async function syncUserGearFromStrava(
  db: Db,
  userId: string,
  accessToken: string,
  opts: { dryRun?: boolean } = {},
): Promise<GearSyncResult> {
  const dryRun = opts.dryRun ?? false;

  type StravaGearData = {
    name: string;
    distance: number;
    retired: boolean;
    gearType: GearType;
    frameType?: number;
  };
  const gearData = new Map<string, StravaGearData>();

  // 1. The athlete profile carries the complete shoe + bike list (incl. unused).
  try {
    const athlete = await stravaApiService.getAthlete(accessToken);
    for (const s of athlete.shoes ?? []) {
      if (!s?.id) continue;
      gearData.set(s.id, {
        name: s.name,
        distance: s.distance ?? 0,
        retired: s.retired ?? false,
        gearType: "SHOES",
      });
    }
    for (const b of athlete.bikes ?? []) {
      if (!b?.id) continue;
      gearData.set(b.id, {
        name: b.name,
        distance: b.distance ?? 0,
        retired: b.retired ?? false,
        gearType: "BICYCLE",
        frameType: b.frame_type,
      });
    }
  } catch (err) {
    logger.warn(
      { err, userId },
      "getAthlete failed during gear sync; using activity gear ids only",
    );
  }

  // 2. Supplement with gear referenced by the user's shoe/bike activities
  //    (catches retired gear the profile omits): infer each gear's type from the
  //    activity sport type and tally road/trail votes for shoe surface.
  const actRows = await db
    .select({ stravaGearId: activities.gearId, sportType: activities.sportType })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNotNull(activities.gearId),
        inArray(activities.sportType, [...STRAVA_GEAR_SPORT_TYPES]),
      ),
    );
  const trailVotes = new Map<string, { trail: number; total: number }>();
  const gearTypeByGid = new Map<string, GearType>();
  const activityGearIds = new Set<string>();
  for (const r of actRows) {
    const gid = r.stravaGearId;
    if (!gid) continue;
    const ctx = gearContextForActivity(r.sportType, false);
    if (!ctx) continue;
    activityGearIds.add(gid);
    if (!gearTypeByGid.has(gid)) gearTypeByGid.set(gid, ctx.gearType);
    if (ctx.gearType === "SHOES") {
      const v = trailVotes.get(gid) ?? { trail: 0, total: 0 };
      v.total += 1;
      if (r.sportType === "TrailRun") v.trail += 1;
      trailVotes.set(gid, v);
    }
  }
  for (const gid of activityGearIds) {
    if (gearData.has(gid)) continue;
    const gearType = gearTypeByGid.get(gid) ?? "SHOES";
    try {
      const g = await stravaApiService.getGear(accessToken, gid);
      gearData.set(gid, {
        name: g.name,
        distance: g.distance ?? 0,
        retired: g.retired ?? false,
        gearType,
        frameType: g.frame_type,
      });
    } catch (err) {
      logger.warn({ err, userId, gid }, "getGear failed during gear sync; skipping");
    }
  }

  let created = 0;
  let updated = 0;
  let linked = 0;

  for (const [stravaGearId, data] of gearData) {
    let surface: GearSurface;
    if (data.gearType === "BICYCLE") {
      surface = surfaceFromFrameType(data.frameType);
    } else {
      const votes = trailVotes.get(stravaGearId);
      surface = votes && votes.total > 0 && votes.trail * 2 >= votes.total ? "TRAIL" : "ROAD";
    }
    const { brands, fallbackModel } = brandParseOptions(data.gearType);
    const { brand, model } = parseBrandModel(data.name, brands, fallbackModel);
    const existing = await gearRepo.findByStravaGearId(db, userId, stravaGearId);

    if (dryRun) {
      if (existing) updated += 1;
      else created += 1;
      continue;
    }

    if (!existing) {
      const gear = await gearRepo.create(db, userId, {
        gearType: data.gearType,
        brand,
        model,
        nickname: null,
        surface,
        isActive: !data.retired,
        retiredAt: data.retired ? new Date() : null,
        stravaGearId,
        baselineDistanceMeters: data.distance,
        baselineDate: new Date(),
      });
      created += 1;
      linked += await gearRepo.linkActivitiesByStravaGearId(db, userId, stravaGearId, gear.id);
      await gearRepo.recompute(db, gear.id);
    } else {
      linked += await gearRepo.linkActivitiesByStravaGearId(db, userId, stravaGearId, existing.id);
      await gearRepo.update(db, userId, existing.id, {
        isActive: !data.retired,
        retiredAt: data.retired ? (existing.retiredAt ?? new Date()) : null,
      });
      await gearRepo.resync(db, existing.id, data.distance);
      updated += 1;
    }
  }

  return { created, updated, linked };
}

interface GearLinkOpts {
  stravaGearId: string;
  sportType: string;
  indoor?: boolean;
  startDateLocal: Date;
}

async function importGearFromStrava(
  db: Db,
  userId: string,
  accessToken: string,
  opts: GearLinkOpts,
): Promise<gearRepo.GearDao> {
  const g = await stravaApiService.getGear(accessToken, opts.stravaGearId);
  const ctx = gearContextForActivity(opts.sportType, opts.indoor ?? false);
  const gearType = ctx?.gearType ?? "SHOES";
  const surface: GearSurface =
    gearType === "BICYCLE" && ctx?.surface == null
      ? surfaceFromFrameType(g.frame_type)
      : (ctx?.surface ?? "ROAD");
  const { brands, fallbackModel } = brandParseOptions(gearType);
  const { brand, model } = parseBrandModel(g.name, brands, fallbackModel);
  return gearRepo.create(db, userId, {
    gearType,
    brand,
    model,
    nickname: null,
    surface,
    isActive: !(g.retired ?? false),
    retiredAt: g.retired ? new Date() : null,
    stravaGearId: opts.stravaGearId,
    baselineDistanceMeters: g.distance ?? 0,
    baselineDate: opts.startDateLocal,
  });
}

/**
 * On Strava ingest, resolve (lazy-importing if needed) the local gear for an
 * activity's Strava gear id and assign it. A newly-imported gear's baseline is
 * anchored at the triggering activity's date, so that activity — already inside
 * Strava's distance snapshot — isn't double-counted; later activities add normally.
 */
export async function linkActivityGearOnIngest(
  db: Db,
  userId: string,
  accessToken: string,
  activityId: number,
  opts: GearLinkOpts,
): Promise<void> {
  let gear = await gearRepo.findByStravaGearId(db, userId, opts.stravaGearId);
  if (!gear) {
    try {
      gear = await importGearFromStrava(db, userId, accessToken, opts);
    } catch (err) {
      logger.warn(
        { err, userId, stravaGearId: opts.stravaGearId },
        "lazy gear import failed on ingest; leaving activity unlinked",
      );
      return;
    }
  }
  await gearRepo.assignActivityToGear(db, userId, activityId, gear.id);
}

/**
 * A Strava `update` webhook changed the activity's gear: re-resolve the local
 * gear (lazy-importing like ingest), refresh a known gear's attributes from
 * Strava, and move the activity onto it via assignActivityToGear (which keeps
 * both gears' counters correct). Null clears the link. Returns whether the
 * re-link was applied — false only when a lazy import failed.
 */
export async function relinkActivityGearFromStrava(
  db: Db,
  userId: string,
  accessToken: string,
  activityId: number,
  opts: { stravaGearId: string | null; sportType: string; indoor?: boolean; startDateLocal: Date },
): Promise<boolean> {
  if (opts.stravaGearId === null) {
    await gearRepo.assignActivityToGear(db, userId, activityId, null);
    return true;
  }

  const linkOpts = { ...opts, stravaGearId: opts.stravaGearId };
  let gear = await gearRepo.findByStravaGearId(db, userId, opts.stravaGearId);
  if (!gear) {
    try {
      gear = await importGearFromStrava(db, userId, accessToken, linkOpts);
    } catch (err) {
      logger.warn(
        { err, userId, stravaGearId: opts.stravaGearId },
        "lazy gear import failed on webhook update; keeping existing link",
      );
      return false;
    }
  } else {
    try {
      const g = await stravaApiService.getGear(accessToken, opts.stravaGearId);
      const { brands, fallbackModel } = brandParseOptions(gear.gearType);
      const { brand, model } = parseBrandModel(g.name, brands, fallbackModel);
      await gearRepo.update(db, userId, gear.id, {
        brand,
        model,
        isActive: !(g.retired ?? false),
        retiredAt: g.retired ? (gear.retiredAt ?? new Date()) : null,
      });
    } catch (err) {
      logger.warn(
        { err, userId, stravaGearId: opts.stravaGearId },
        "gear attribute refresh failed on webhook update; linking anyway",
      );
    }
  }
  await gearRepo.assignActivityToGear(db, userId, activityId, gear.id);
  return true;
}
