import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../src/config";
import * as schema from "../src/schema";
import { activities, users } from "../src/schema";
import { isReviewUser, setReviewUserId } from "../src/services/review_account";
import {
  type ComparisonRow,
  summarizeComparison,
  toComparisonRows,
  worstOutliers,
} from "./_load_comparison";
import { runScript } from "./_harness";

// Report-only comparison of our self-computed `training_load` against
// intervals.icu's `icu_training_load`, the accept gate for GAP calibration.
// Never writes regardless of env. USER_ID limits to one user. The store-review
// demo account is excluded: its corpus is seeded with ours == icu by
// construction, so it would flatter every statistic in the gate.

const ONLY_USER_ID = process.env.USER_ID ?? null;
const OUTLIER_COUNT = 10;

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

/**
 * Arm `isReviewUser` from the review email. Read-only on purpose — the boot path
 * (`prepareReviewAccount`) also promotes the row, which this script must not do.
 */
async function armReviewUser(): Promise<string | null> {
  if (config.REVIEW_ACCOUNT_EMAIL === undefined) return null;
  const row = await db.query.users.findFirst({
    where: eq(users.email, config.REVIEW_ACCOUNT_EMAIL),
    columns: { id: true },
  });
  if (!row) return null;
  setReviewUserId(row.id);
  return row.id;
}

async function loadRows(): Promise<ComparisonRow[]> {
  const where = ONLY_USER_ID
    ? and(
        eq(activities.userId, ONLY_USER_ID),
        isNotNull(activities.trainingLoad),
        isNotNull(activities.icuTrainingLoad),
      )
    : and(isNotNull(activities.trainingLoad), isNotNull(activities.icuTrainingLoad));

  const rows = await db
    .select({
      id: activities.id,
      userId: activities.userId,
      startDateLocal: activities.startDateLocal,
      sportType: activities.sportType,
      source: activities.trainingLoadSource,
      ours: activities.trainingLoad,
      icu: activities.icuTrainingLoad,
    })
    .from(activities)
    .where(where);

  return toComparisonRows(rows, isReviewUser);
}

async function main(): Promise<Record<string, unknown>> {
  console.log(`[compare_training_load] onlyUserId=${ONLY_USER_ID ?? "<all>"}`);

  const reviewUserId = await armReviewUser();
  console.log(`[compare_training_load] excludedReviewUser=${reviewUserId ?? "<none>"}`);

  const rows = await loadRows();
  console.log(`[compare_training_load] compared activities=${rows.length}`);
  if (rows.length === 0) {
    console.log("[compare_training_load] nothing to compare");
    return { comparedActivities: 0, groups: [] };
  }

  const summaries = summarizeComparison(rows);

  const cols: [string, number][] = [
    ["sportGroup", 11],
    ["source", 8],
    ["count", 6],
    ["medAbsErr", 10],
    ["p90AbsErr", 10],
    ["medAbsRel", 10],
    ["p90AbsRel", 10],
    ["meanSgnRel", 11],
  ];
  console.log("\n=== per group (sport x source) ===");
  console.log(cols.map(([h, w]) => pad(h, w)).join("  "));
  for (const s of summaries) {
    console.log(
      [
        pad(s.sportGroup, cols[0][1]),
        pad(s.source, cols[1][1]),
        pad(s.count, cols[2][1]),
        pad(fmt(s.medianAbsError), cols[3][1]),
        pad(fmt(s.p90AbsError), cols[4][1]),
        pad(fmt(s.medianAbsRelError), cols[5][1]),
        pad(fmt(s.p90AbsRelError), cols[6][1]),
        pad(fmt(s.meanSignedRelError), cols[7][1]),
      ].join("  "),
    );
  }

  const outliers = worstOutliers(rows, OUTLIER_COUNT);
  const ocols: [string, number][] = [
    ["activityId", 12],
    ["date", 12],
    ["sport", 14],
    ["source", 8],
    ["ours", 9],
    ["icu", 9],
    ["error", 9],
    ["relError", 9],
  ];
  console.log(`\n=== ${OUTLIER_COUNT} worst outliers (by |error|) ===`);
  console.log(ocols.map(([h, w]) => pad(h, w)).join("  "));
  for (const o of outliers) {
    console.log(
      [
        pad(o.activityId, ocols[0][1]),
        pad(o.date, ocols[1][1]),
        pad(o.sportType, ocols[2][1]),
        pad(o.source ?? "unknown", ocols[3][1]),
        pad(fmt(o.ours), ocols[4][1]),
        pad(fmt(o.icu), ocols[5][1]),
        pad(fmt(o.error), ocols[6][1]),
        pad(fmt(o.relError), ocols[7][1]),
      ].join("  "),
    );
  }

  return { comparedActivities: rows.length, groups: summaries };
}

runScript({ name: "compare_training_load", once: false, db, pool }, () => main());
