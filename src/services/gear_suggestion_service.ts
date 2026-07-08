import * as gearRepo from "../repositories/gear_repository";
import {
  type GearSurface,
  type GearType,
  gearContextForActivity,
  type TrainingType,
  trainingBucketFor,
} from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export type GearSuggestionInput = {
  sportType: string;
  indoor: boolean;
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
 * Every step is keyed on the activity's gear type (D4/D7): the user's deliberate
 * Strava gear change → per-signature default → use-type match →
 * (gearType, bucket, surface) default → recents-by-type. Candidates are filtered
 * to the activity's gear type, and retired gear is skipped at every step. When the
 * activity's surface is determinable, the use-type and recents steps are further
 * scoped to that surface (skis fall back to type-only). Recents and use-type lookups
 * memoize the in-flight promise per `gearType:surface` key, so concurrent activities
 * share one query.
 */
export async function createGearSuggester(
  db: Db,
  userId: string,
): Promise<(input: GearSuggestionInput) => Promise<GearSuggestions>> {
  const [defaults, signatureDefaults, activeTypeById] = await Promise.all([
    gearRepo.getDefaults(db, userId),
    gearRepo.getSignatureDefaults(db, userId),
    gearRepo.activeGearTypeById(db, userId),
  ]);
  const defaultMap = new Map(
    defaults.map((d) => [`${d.gearType}:${d.bucket}:${d.surface}`, d.gearId]),
  );
  const signatureDefaultMap = new Map(
    signatureDefaults.map((d) => [d.intervalStructureId, d.gearId]),
  );

  const recentsCache = new Map<string, Promise<number[]>>();
  const recentsFor = (gearType: GearType, surface: GearSurface | null): Promise<number[]> => {
    const key = `${gearType}:${surface}`;
    let recents = recentsCache.get(key);
    if (!recents) {
      recents = gearRepo.recentGearIdsByGearType(db, userId, gearType, surface, MAX_SUGGESTIONS);
      recentsCache.set(key, recents);
    }
    return recents;
  };

  const useTypeMatchCache = new Map<string, Promise<number[]>>();
  const useTypeMatchesFor = (
    trainingType: TrainingType,
    gearType: GearType,
    surface: GearSurface | null,
  ): Promise<number[]> => {
    const key = `${trainingType}:${gearType}:${surface}`;
    let matches = useTypeMatchCache.get(key);
    if (!matches) {
      matches = gearRepo.gearIdsByUseType(
        db,
        userId,
        trainingType,
        gearType,
        surface,
        MAX_SUGGESTIONS,
      );
      useTypeMatchCache.set(key, matches);
    }
    return matches;
  };

  return async (input) => {
    const ctx = gearContextForActivity(input.sportType, input.indoor);
    if (!ctx) return { suggestedGearId: null, gearSuggestions: [] };
    const { gearType, surface } = ctx;
    const bucket = trainingBucketFor(input.trainingType);

    const ofType = (id: number | null | undefined): number | null =>
      id != null && activeTypeById.get(id) === gearType ? id : null;

    const [useTypeMatches, recents] = await Promise.all([
      input.trainingType ? useTypeMatchesFor(input.trainingType, gearType, surface) : [],
      recentsFor(gearType, surface),
    ]);

    const stravaChoice = input.gearUpdatedFromStrava ? ofType(input.localGearId) : null;
    const signatureDefault =
      input.intervalStructureId != null
        ? ofType(signatureDefaultMap.get(input.intervalStructureId))
        : null;
    const bucketDefault =
      bucket && surface ? ofType(defaultMap.get(`${gearType}:${bucket}:${surface}`)) : null;

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
