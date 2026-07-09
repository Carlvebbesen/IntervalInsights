// Cross-source activity matching tolerances, shared by every ingest path that
// has to decide whether a Strava activity and an intervals.icu activity are the
// same workout (webhook + master sync, both directions). Kept in one place so
// the two sources can never drift apart on what "same workout" means.

export const TIME_TOLERANCE_MS = 5 * 60 * 1000;
export const DISTANCE_TOLERANCE_RATIO = 0.03;

/**
 * True when two activities from different sources are the same workout: start
 * times within TIME_TOLERANCE_MS and distances within DISTANCE_TOLERANCE_RATIO.
 * A null/undefined distance on either side is a non-match — distance is the
 * discriminating signal; start time alone is too coarse for back-to-back
 * sessions. The band is built around the first (reference) distance.
 */
export function withinMatchTolerance(
  refStartMs: number,
  refDistance: number | null | undefined,
  candidateStartMs: number,
  candidateDistance: number | null | undefined,
): boolean {
  if (Number.isNaN(refStartMs) || Number.isNaN(candidateStartMs)) return false;
  if (refDistance == null || candidateDistance == null) return false;
  if (Math.abs(refStartMs - candidateStartMs) > TIME_TOLERANCE_MS) return false;
  const { min, max } = distanceBand(refDistance);
  return candidateDistance >= min && candidateDistance <= max;
}

/** Inclusive [min, max] distance band around a reference distance. */
export function distanceBand(distance: number): { min: number; max: number } {
  return {
    min: distance * (1 - DISTANCE_TOLERANCE_RATIO),
    max: distance * (1 + DISTANCE_TOLERANCE_RATIO),
  };
}
