import { RUNNING_SPORT_TYPES } from "../src/schema/enums";

// Pure computation for the training-load comparison harness
// (`compare_training_load.ts`). No DB/IO — unit-tested against hand-computed
// fixtures.

export type SportGroup = "running" | "other";

export interface ComparisonRow {
  activityId: number;
  date: string;
  sportType: string;
  source: string | null;
  ours: number;
  icu: number;
}

export interface GroupSummary {
  sportGroup: SportGroup;
  source: string;
  count: number;
  medianAbsError: number;
  p90AbsError: number;
  medianAbsRelError: number;
  p90AbsRelError: number;
  meanSignedRelError: number;
}

export interface Outlier {
  activityId: number;
  date: string;
  sportType: string;
  source: string | null;
  ours: number;
  icu: number;
  error: number;
  relError: number;
}

/** The raw shape `compare_training_load` selects out of `activities`. */
export interface ActivityLoadRow {
  id: number;
  userId: string;
  startDateLocal: Date;
  sportType: string;
  source: string | null;
  ours: number | null;
  icu: number | null;
}

/**
 * DB rows → comparison rows, dropping users the caller excludes. The store-review
 * demo account is excluded there: its corpus is seeded with ours == icu, so its
 * rows are a zero-error block that flatters every statistic in the gate.
 */
export function toComparisonRows(
  rows: ActivityLoadRow[],
  isExcluded: (userId: string) => boolean,
): ComparisonRow[] {
  return rows
    .filter((r) => !isExcluded(r.userId))
    .map((r) => ({
      activityId: r.id,
      date: r.startDateLocal.toISOString().slice(0, 10),
      sportType: r.sportType,
      source: r.source,
      ours: r.ours as number,
      icu: r.icu as number,
    }));
}

export function sportGroupOf(sportType: string): SportGroup {
  return (RUNNING_SPORT_TYPES as readonly string[]).includes(sportType) ? "running" : "other";
}

export function errorOf(row: ComparisonRow): number {
  return row.ours - row.icu;
}

export function relErrorOf(row: ComparisonRow): number {
  return errorOf(row) / Math.max(row.icu, 1);
}

/** Percentile via linear interpolation between closest ranks (numpy default). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summarizeComparison(rows: ComparisonRow[]): GroupSummary[] {
  const groups = new Map<string, ComparisonRow[]>();
  for (const row of rows) {
    const key = `${sportGroupOf(row.sportType)}|${row.source ?? "unknown"}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const summaries: GroupSummary[] = [];
  for (const [key, bucket] of groups) {
    const [sportGroup, source] = key.split("|") as [SportGroup, string];
    const absErrors = bucket.map((r) => Math.abs(errorOf(r)));
    const absRelErrors = bucket.map((r) => Math.abs(relErrorOf(r)));
    const signedRelErrors = bucket.map((r) => relErrorOf(r));
    summaries.push({
      sportGroup,
      source,
      count: bucket.length,
      medianAbsError: median(absErrors),
      p90AbsError: percentile(absErrors, 90),
      medianAbsRelError: median(absRelErrors),
      p90AbsRelError: percentile(absRelErrors, 90),
      meanSignedRelError: mean(signedRelErrors),
    });
  }

  summaries.sort((a, b) =>
    a.sportGroup === b.sportGroup
      ? a.source < b.source
        ? -1
        : a.source > b.source
          ? 1
          : 0
      : a.sportGroup < b.sportGroup
        ? -1
        : 1,
  );
  return summaries;
}

/** The `n` rows with the largest absolute error, descending. */
export function worstOutliers(rows: ComparisonRow[], n: number): Outlier[] {
  return [...rows]
    .map((r) => ({
      activityId: r.activityId,
      date: r.date,
      sportType: r.sportType,
      source: r.source,
      ours: r.ours,
      icu: r.icu,
      error: errorOf(r),
      relError: relErrorOf(r),
    }))
    .sort((a, b) => Math.abs(b.error) - Math.abs(a.error))
    .slice(0, n);
}
