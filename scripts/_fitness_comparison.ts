import { mean, median, percentile } from "./_load_comparison";

// Pure computation for the fitness-series comparison harness
// (`compare_fitness_series.ts`). No DB/IO — unit-tested against hand-computed
// fixtures. Reuses the numpy-style stats from `_load_comparison`.

export interface SeriesPoint {
  date: string;
  ctl: number;
  atl: number;
}

export interface AlignedDelta {
  date: string;
  year: number;
  dCtl: number;
  dAtl: number;
}

export interface DeltaSummary {
  year: number | "all";
  count: number;
  medAbsCtl: number;
  p90AbsCtl: number;
  medAbsAtl: number;
  p90AbsAtl: number;
  /** Mean signed Δctl (ours − reference) — the bias. */
  meanSignedCtl: number;
}

/** Inner-join two series by date; Δ = ours − reference. Unmatched dates drop. */
export function alignSeries(ours: SeriesPoint[], reference: SeriesPoint[]): AlignedDelta[] {
  const refByDate = new Map(reference.map((p) => [p.date, p]));
  const deltas: AlignedDelta[] = [];
  for (const o of ours) {
    const ref = refByDate.get(o.date);
    if (!ref) continue;
    deltas.push({
      date: o.date,
      year: Number(o.date.slice(0, 4)),
      dCtl: o.ctl - ref.ctl,
      dAtl: o.atl - ref.atl,
    });
  }
  return deltas;
}

function summarizeOne(year: number | "all", deltas: AlignedDelta[]): DeltaSummary {
  const absCtl = deltas.map((d) => Math.abs(d.dCtl));
  const absAtl = deltas.map((d) => Math.abs(d.dAtl));
  const signedCtl = deltas.map((d) => d.dCtl);
  return {
    year,
    count: deltas.length,
    medAbsCtl: median(absCtl),
    p90AbsCtl: percentile(absCtl, 90),
    medAbsAtl: median(absAtl),
    p90AbsAtl: percentile(absAtl, 90),
    meanSignedCtl: mean(signedCtl),
  };
}

/** Per-calendar-year summaries (ascending) followed by an "all" row. */
export function summarizeByYear(deltas: AlignedDelta[]): DeltaSummary[] {
  const byYear = new Map<number, AlignedDelta[]>();
  for (const d of deltas) {
    const bucket = byYear.get(d.year);
    if (bucket) bucket.push(d);
    else byYear.set(d.year, [d]);
  }
  const rows = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((y) => summarizeOne(y, byYear.get(y) as AlignedDelta[]));
  if (deltas.length > 0) rows.push(summarizeOne("all", deltas));
  return rows;
}

/** Collapse per-day snapshot rows to one point per day (latest wins). */
export function latestPerDay(points: SeriesPoint[]): SeriesPoint[] {
  const byDate = new Map<string, SeriesPoint>();
  for (const p of points) byDate.set(p.date, p);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
