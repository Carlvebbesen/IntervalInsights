import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { computeFitnessSeries } from "../src/services/fitness_metrics_service";
import { intervalsApiService } from "../src/services/intervals_api_service";
import { withIntervalsToken } from "../src/services/intervals_token_helper";
import * as schema from "../src/schema";
import { activities, users } from "../src/schema";
import {
  type AlignedDelta,
  type DeltaSummary,
  type SeriesPoint,
  alignSeries,
  latestPerDay,
  summarizeByYear,
} from "./_fitness_comparison";
import { runScript } from "./_harness";

// Report-only parallel-run tool: compares our self-computed combined CTL/ATL
// series against intervals.icu's own numbers — the intervals.icu wellness feed
// (the authoritative series) and, as a second checkpoint, the per-activity
// `icu_ctl`/`icu_atl` snapshots. Never writes. USER_ID limits to one user.

const ONLY_USER_ID = process.env.USER_ID ?? null;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function printSummaryTable(label: string, rows: DeltaSummary[]): void {
  const cols: [string, number][] = [
    ["year", 6],
    ["count", 7],
    ["medΔctl", 9],
    ["p90Δctl", 9],
    ["medΔatl", 9],
    ["p90Δatl", 9],
    ["biasCtl", 9],
  ];
  console.log(`\n--- ${label} ---`);
  if (rows.length === 0) {
    console.log("  (no aligned days)");
    return;
  }
  console.log(cols.map(([h, w]) => pad(h, w)).join("  "));
  for (const r of rows) {
    console.log(
      [
        pad(r.year, cols[0][1]),
        pad(r.count, cols[1][1]),
        pad(fmt(r.medAbsCtl), cols[2][1]),
        pad(fmt(r.p90AbsCtl), cols[3][1]),
        pad(fmt(r.medAbsAtl), cols[4][1]),
        pad(fmt(r.p90AbsAtl), cols[5][1]),
        pad(fmt(r.meanSignedCtl), cols[6][1]),
      ].join("  "),
    );
  }
}

async function loadRange(userId: string): Promise<{ oldest: string; newest: string } | null> {
  const [row] = await db
    .select({
      oldest: sql<string | null>`to_char(min(date(${activities.startDateLocal})), 'YYYY-MM-DD')`,
      newest: sql<string | null>`to_char(max(date(${activities.startDateLocal})), 'YYYY-MM-DD')`,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        sql`(${activities.trainingLoad} IS NOT NULL OR ${activities.icuTrainingLoad} IS NOT NULL)`,
      ),
    );
  if (!row?.oldest || !row?.newest) return null;
  return { oldest: row.oldest, newest: row.newest };
}

async function snapshotSeries(userId: string): Promise<SeriesPoint[]> {
  const rows = await db
    .select({
      date: sql<string>`to_char(date(${activities.startDateLocal}), 'YYYY-MM-DD')`,
      ctl: activities.icuCtl,
      atl: activities.icuAtl,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        isNotNull(activities.icuCtl),
        isNotNull(activities.icuAtl),
      ),
    )
    .orderBy(asc(activities.startDateLocal));
  return latestPerDay(
    rows.map((r) => ({ date: r.date, ctl: r.ctl as number, atl: r.atl as number })),
  );
}

async function wellnessSeries(
  userId: string,
  oldest: string,
  newest: string,
): Promise<SeriesPoint[] | null> {
  const result = await withIntervalsToken(userId, (accessToken) =>
    intervalsApiService.getWellness(accessToken, oldest, newest),
  );
  if (result.status === "not_linked") return null;
  return result.data
    .filter((r) => r.ctl != null && r.atl != null)
    .map((r) => ({ date: r.id, ctl: r.ctl as number, atl: r.atl as number }));
}

async function main(): Promise<Record<string, unknown>> {
  console.log(`[compare_fitness_series] onlyUserId=${ONLY_USER_ID ?? "<all>"}`);

  const userRows = ONLY_USER_ID
    ? [{ id: ONLY_USER_ID }]
    : await db.select({ id: users.id }).from(users);

  const wellnessDeltas: AlignedDelta[] = [];
  const snapshotDeltas: AlignedDelta[] = [];
  const perUser: Record<string, { wellnessDays: number; snapshotDays: number }> = {};

  for (const { id: userId } of userRows) {
    const range = await loadRange(userId);
    if (!range) continue;

    const series = await computeFitnessSeries(db, userId, range);
    const ours: SeriesPoint[] = series.map((p) => ({ date: p.date, ctl: p.ctl, atl: p.atl }));
    if (ours.length === 0) continue;

    const wellness = await wellnessSeries(userId, range.oldest, range.newest);
    const snapshots = await snapshotSeries(userId);

    const uWellness = wellness ? alignSeries(ours, wellness) : [];
    const uSnapshot = alignSeries(ours, snapshots);
    if (uWellness.length === 0 && uSnapshot.length === 0) continue;

    wellnessDeltas.push(...uWellness);
    snapshotDeltas.push(...uSnapshot);
    perUser[userId] = { wellnessDays: uWellness.length, snapshotDays: uSnapshot.length };

    console.log(
      `\n==================== user ${userId} (${range.oldest}..${range.newest}) ====================`,
    );
    if (!wellness) console.log("  intervals.icu not linked — wellness comparison skipped");
    printSummaryTable("vs intervals.icu wellness ctl/atl", summarizeByYear(uWellness));
    printSummaryTable("vs per-activity icu_ctl/icu_atl snapshots", summarizeByYear(uSnapshot));
  }

  const wellnessAll = summarizeByYear(wellnessDeltas).find((r) => r.year === "all") ?? null;
  const snapshotAll = summarizeByYear(snapshotDeltas).find((r) => r.year === "all") ?? null;

  console.log("\n==================== OVERALL ====================");
  printSummaryTable("vs intervals.icu wellness (all users)", summarizeByYear(wellnessDeltas));
  printSummaryTable("vs per-activity snapshots (all users)", summarizeByYear(snapshotDeltas));

  return {
    users: Object.keys(perUser).length,
    wellnessComparedDays: wellnessDeltas.length,
    snapshotComparedDays: snapshotDeltas.length,
    wellnessAll,
    snapshotAll,
    perUser,
  };
}

runScript({ name: "compare_fitness_series", once: false, db, pool }, () => main());
