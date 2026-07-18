import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { activities, RUNNING_SPORT_TYPES } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

const RUNNING_TYPES = [...RUNNING_SPORT_TYPES];

export interface DailyLoad {
  date: string;
  load: number;
}

export interface IcuFitnessSnapshot {
  date: string;
  icuCtl: number;
  icuAtl: number;
}

/**
 * Per-day summed training load for a user, keyed by the naive local wall-clock
 * day (`date(start_date_local)`, no timezone conversion). Load per activity is
 * `COALESCE(training_load, icu_training_load)`; activities with neither are
 * excluded so a day with no real load produces no row (the fold treats missing
 * days as rest). Ordered by date ascending.
 */
export async function dailyLoadSums(
  db: Db,
  userId: string,
  opts?: { sport?: string; oldest?: string; newest?: string },
): Promise<DailyLoad[]> {
  const day = sql`date(${activities.startDateLocal})`;
  const load = sql`COALESCE(${activities.trainingLoad}, ${activities.icuTrainingLoad})`;

  const conditions = [
    eq(activities.userId, userId),
    sql`(${activities.trainingLoad} IS NOT NULL OR ${activities.icuTrainingLoad} IS NOT NULL)`,
  ];
  if (opts?.sport) {
    conditions.push(
      opts.sport === "running"
        ? inArray(activities.sportType, RUNNING_TYPES)
        : eq(activities.sportType, opts.sport),
    );
  }
  if (opts?.oldest) conditions.push(sql`${day} >= ${opts.oldest}`);
  if (opts?.newest) conditions.push(sql`${day} <= ${opts.newest}`);

  const rows = await db
    .select({
      date: sql<string>`to_char(${day}, 'YYYY-MM-DD')`,
      load: sql<string>`sum(${load})`,
    })
    .from(activities)
    .where(and(...conditions))
    .groupBy(day)
    .orderBy(asc(day));

  return rows.map((r) => ({ date: r.date, load: Number(r.load) }));
}

/**
 * The earliest activity (by local start) carrying both intervals.icu fitness
 * snapshot fields, used to seed the combined series with intervals.icu's own
 * CTL/ATL instead of a cold zero start. Null when the user has no such row.
 */
export async function earliestIcuFitnessSnapshot(
  db: Db,
  userId: string,
): Promise<IcuFitnessSnapshot | null> {
  const [row] = await db
    .select({
      date: sql<string>`to_char(date(${activities.startDateLocal}), 'YYYY-MM-DD')`,
      icuCtl: activities.icuCtl,
      icuAtl: activities.icuAtl,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNotNull(activities.icuCtl),
        isNotNull(activities.icuAtl),
      ),
    )
    .orderBy(asc(activities.startDateLocal))
    .limit(1);

  if (!row || row.icuCtl == null || row.icuAtl == null) return null;
  return { date: row.date, icuCtl: row.icuCtl, icuAtl: row.icuAtl };
}
