export const TIME_TOLERANCE_MS = 5 * 60 * 1000;
export const DISTANCE_TOLERANCE_RATIO = 0.03;
export const DURATION_TOLERANCE_RATIO = 0.02;
export const MIN_DURATION_TOLERANCE_SECONDS = 60;

export interface MatchSubject {
  startMs: number;
  distance: number | null | undefined;
  movingTime?: number | null;
  sportType?: string | null;
}

export function distanceBand(distance: number): { min: number; max: number } {
  return {
    min: distance * (1 - DISTANCE_TOLERANCE_RATIO),
    max: distance * (1 + DISTANCE_TOLERANCE_RATIO),
  };
}

export function durationBand(seconds: number): { min: number; max: number } {
  const tolerance = Math.max(MIN_DURATION_TOLERANCE_SECONDS, seconds * DURATION_TOLERANCE_RATIO);
  return { min: seconds - tolerance, max: seconds + tolerance };
}

/**
 * Distance band when both sides actually measure distance, duration band when
 * neither does. Zero-distance sports (Elliptical, WeightTraining, Yoga, pool
 * Swim) store `distance: 0` from every provider, so a distance-only comparison
 * can never match them across sources.
 */
export function withinMatchTolerance(ref: MatchSubject, candidate: MatchSubject): boolean {
  if (Number.isNaN(ref.startMs) || Number.isNaN(candidate.startMs)) return false;
  if (Math.abs(ref.startMs - candidate.startMs) > TIME_TOLERANCE_MS) return false;

  const refDistance = ref.distance;
  const candidateDistance = candidate.distance;
  if (refDistance == null || candidateDistance == null) return false;

  if (refDistance > 0 || candidateDistance > 0) {
    if (refDistance <= 0 || candidateDistance <= 0) return false;
    const { min, max } = distanceBand(refDistance);
    return candidateDistance >= min && candidateDistance <= max;
  }

  // Start time alone is weak evidence — zero-distance sports cluster (gym then
  // yoga), so the fallback also demands the same sport and a similar duration.
  if (!sameSport(ref.sportType, candidate.sportType)) return false;
  if (ref.movingTime == null || candidate.movingTime == null) return false;
  const { min, max } = durationBand(ref.movingTime);
  return candidate.movingTime >= min && candidate.movingTime <= max;
}

function sameSport(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
