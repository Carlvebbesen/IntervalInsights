import {
  type DailyLoad,
  dailyLoadSums,
  earliestIcuFitnessSnapshot,
} from "../repositories/fitness_metrics_repository";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

// Exponential impulse-response EWMA (intervals.icu-compatible). Every calendar
// day runs the recursion, including zero-load rest days. See
// resources/recipes/training-metrics-formulas.md.
const CTL_DECAY = Math.exp(-1 / 42);
const ATL_DECAY = Math.exp(-1 / 7);
const RAMP_WINDOW_DAYS = 7;

export interface FitnessMetricsPoint {
  date: string;
  ctl: number;
  atl: number;
  /** Same-day form: ctl − atl (intervals.icu convention). */
  tsb: number;
  /** ctl_d − ctl_{d−7}; null when d−7 predates the fold. */
  rampRate: number | null;
  /** That day's summed training load (0 on rest days). */
  load: number;
}

export interface FitnessSeed {
  /** The value standing at END of this day; the fold starts the next day. */
  date: string;
  ctl: number;
  atl: number;
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure EWMA fold. Iterates every calendar day from the fold start through `to`
 * (rest days contribute load 0) and returns only the points within [from, to]
 * — decay history is always accumulated from the start so slicing never
 * changes the values.
 *
 * Fold start: the day after `seed.date` when seeded (seed = the value standing
 * at end of seed.date), else the earliest `dailyLoads` date starting from
 * ctl=atl=0. `dailyLoads` entries before the seed date are ignored (superseded
 * by the seed).
 */
export function foldFitnessSeries(
  dailyLoads: DailyLoad[],
  opts: { from: string; to: string; seed?: FitnessSeed },
): FitnessMetricsPoint[] {
  const { from, to, seed } = opts;

  const loadByDate = new Map<string, number>();
  for (const dl of dailyLoads) loadByDate.set(dl.date, dl.load);

  let cursor: string;
  let prevCtl: number;
  let prevAtl: number;
  const ctlByDate = new Map<string, number>();

  if (seed) {
    prevCtl = seed.ctl;
    prevAtl = seed.atl;
    ctlByDate.set(seed.date, seed.ctl);
    cursor = shiftIsoDate(seed.date, 1);
  } else {
    if (dailyLoads.length === 0) return [];
    let earliest = dailyLoads[0].date;
    for (const dl of dailyLoads) if (dl.date < earliest) earliest = dl.date;
    cursor = earliest;
    prevCtl = 0;
    prevAtl = 0;
  }

  const points: FitnessMetricsPoint[] = [];
  while (cursor <= to) {
    const load = loadByDate.get(cursor) ?? 0;
    const ctl = prevCtl * CTL_DECAY + load * (1 - CTL_DECAY);
    const atl = prevAtl * ATL_DECAY + load * (1 - ATL_DECAY);
    ctlByDate.set(cursor, ctl);

    const prior = ctlByDate.get(shiftIsoDate(cursor, -RAMP_WINDOW_DAYS));
    const rampRate = prior === undefined ? null : ctl - prior;

    if (cursor >= from) {
      points.push({ date: cursor, ctl, atl, tsb: ctl - atl, rampRate, load });
    }

    prevCtl = ctl;
    prevAtl = atl;
    cursor = shiftIsoDate(cursor, 1);
  }

  return points;
}

/**
 * DB-facing series assembly (additive — no existing behavior depends on it yet).
 * Folds over the user's ENTIRE load history so decay is correct, then slices
 * [oldest, newest]. The combined (no-sport) series seeds from the user's
 * earliest intervals.icu CTL/ATL snapshot when there is no meaningful stored
 * load before it; per-sport series never seed (intervals.icu has no per-sport
 * CTL baseline).
 */
export async function computeFitnessSeries(
  db: Db,
  userId: string,
  opts: { oldest: string; newest: string; sport?: string },
): Promise<FitnessMetricsPoint[]> {
  const dailyLoads = await dailyLoadSums(db, userId, { sport: opts.sport });

  let seed: FitnessSeed | undefined;
  if (!opts.sport) {
    const snapshot = await earliestIcuFitnessSnapshot(db, userId);
    if (snapshot) {
      const priorLoad = dailyLoads
        .filter((d) => d.date < snapshot.date)
        .reduce((sum, d) => sum + d.load, 0);
      // Seed only when our own history before the snapshot is negligible — less
      // than a single day-unit of the fitness the snapshot already represents.
      if (priorLoad < snapshot.icuCtl) {
        seed = {
          date: shiftIsoDate(snapshot.date, -1),
          ctl: snapshot.icuCtl,
          atl: snapshot.icuAtl,
        };
      }
    }
  }

  return foldFitnessSeries(dailyLoads, { from: opts.oldest, to: opts.newest, seed });
}

export async function computeFitnessDay(
  db: Db,
  userId: string,
  date: string,
  sport?: string,
): Promise<FitnessMetricsPoint | null> {
  const points = await computeFitnessSeries(db, userId, { oldest: date, newest: date, sport });
  return points[0] ?? null;
}
