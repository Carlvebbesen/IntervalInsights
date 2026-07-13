export const TIME_TOLERANCE_MS = 5 * 60 * 1000;
export const DISTANCE_TOLERANCE_RATIO = 0.03;

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

export function distanceBand(distance: number): { min: number; max: number } {
  return {
    min: distance * (1 - DISTANCE_TOLERANCE_RATIO),
    max: distance * (1 + DISTANCE_TOLERANCE_RATIO),
  };
}
