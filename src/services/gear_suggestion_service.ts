import * as gearRepo from "../repositories/gear_repository";
import {
  type GearSurface,
  surfaceForSportType,
  type TrainingType,
  trainingBucketFor,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type GearSuggestionInput = {
  sportType: string;
  trainingType: TrainingType | null;
  localGearId: number | null;
  gearUpdatedFromStrava: boolean;
  intervalStructureId: number | null;
};

export type GearSuggestions = {
  suggestedGearId: number | null;
  gearSuggestions: number[];
};

const MAX_SUGGESTIONS = 3;

/**
 * Prefetches the user's gear defaults once and returns a per-activity suggester.
 * Priority order: the user's deliberate Strava gear change → per-signature
 * default → use-type match → (bucket, surface) default → recents-by-surface.
 * Retired gear is skipped at every step. Recents and use-type lookups memoize
 * the in-flight promise per key, so concurrent activities share one query.
 */
export async function createGearSuggester(
  db: Db,
  userId: string,
): Promise<(input: GearSuggestionInput) => Promise<GearSuggestions>> {
  const [defaults, signatureDefaults, activeIds] = await Promise.all([
    gearRepo.getDefaults(db, userId),
    gearRepo.getSignatureDefaults(db, userId),
    gearRepo.activeGearIds(db, userId),
  ]);
  const defaultMap = new Map(defaults.map((d) => [`${d.bucket}:${d.surface}`, d.gearId]));
  const signatureDefaultMap = new Map(
    signatureDefaults.map((d) => [d.intervalStructureId, d.gearId]),
  );
  const activeOnly = (id: number | null | undefined): number | null =>
    id != null && activeIds.has(id) ? id : null;

  const recentsBySurface = new Map<GearSurface, Promise<number[]>>();
  const recentsFor = (surface: GearSurface): Promise<number[]> => {
    let recents = recentsBySurface.get(surface);
    if (!recents) {
      recents = gearRepo.recentGearIdsBySurface(db, userId, surface, MAX_SUGGESTIONS);
      recentsBySurface.set(surface, recents);
    }
    return recents;
  };

  const useTypeMatchCache = new Map<string, Promise<number[]>>();
  const useTypeMatchesFor = (
    trainingType: TrainingType,
    surface: GearSurface,
  ): Promise<number[]> => {
    const key = `${trainingType}:${surface}`;
    let matches = useTypeMatchCache.get(key);
    if (!matches) {
      matches = gearRepo.gearIdsByUseType(db, userId, trainingType, surface, MAX_SUGGESTIONS);
      useTypeMatchCache.set(key, matches);
    }
    return matches;
  };

  return async (input) => {
    const surface = surfaceForSportType(input.sportType);
    const bucket = trainingBucketFor(input.trainingType);
    const [useTypeMatches, recents] = await Promise.all([
      input.trainingType ? useTypeMatchesFor(input.trainingType, surface) : [],
      recentsFor(surface),
    ]);

    const stravaChoice = input.gearUpdatedFromStrava ? activeOnly(input.localGearId) : null;
    const signatureDefault =
      input.intervalStructureId != null
        ? activeOnly(signatureDefaultMap.get(input.intervalStructureId))
        : null;
    const bucketDefault = bucket ? activeOnly(defaultMap.get(`${bucket}:${surface}`)) : null;

    const gearSuggestions: number[] = [];
    for (const id of [
      stravaChoice,
      signatureDefault,
      ...useTypeMatches,
      bucketDefault,
      ...recents,
    ]) {
      if (gearSuggestions.length >= MAX_SUGGESTIONS) break;
      if (id != null && !gearSuggestions.includes(id)) gearSuggestions.push(id);
    }
    return { suggestedGearId: gearSuggestions[0] ?? null, gearSuggestions };
  };
}
