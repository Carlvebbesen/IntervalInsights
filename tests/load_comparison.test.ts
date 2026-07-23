import { describe, expect, it } from "bun:test";
import {
  type ComparisonRow,
  mean,
  median,
  percentile,
  relErrorOf,
  sportGroupOf,
  summarizeComparison,
  toComparisonRows,
  worstOutliers,
} from "../scripts/_load_comparison";

describe("percentile / median / mean", () => {
  it("median of an even set interpolates the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("median of an odd set is the middle value", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("p90 interpolates between closest ranks", () => {
    // rank = 0.9 * 9 = 8.1 → sorted[8]*0.9 + sorted[9]*0.1 = 9*0.9 + 10*0.1 = 9.1
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1, 10);
  });

  it("single-element and empty inputs are handled", () => {
    expect(percentile([42], 90)).toBe(42);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(Number.isNaN(mean([]))).toBe(true);
  });

  it("mean averages", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
});

describe("sportGroupOf", () => {
  it("classifies running vs other", () => {
    expect(sportGroupOf("Run")).toBe("running");
    expect(sportGroupOf("Ride")).toBe("other");
  });
});

describe("relErrorOf", () => {
  it("normalises by icu, flooring the denominator at 1", () => {
    expect(relErrorOf({ ours: 12, icu: 10 } as ComparisonRow)).toBeCloseTo(0.2, 10);
    // icu 0.5 → denom max(0.5,1)=1 → error/1
    expect(relErrorOf({ ours: 2, icu: 0.5 } as ComparisonRow)).toBeCloseTo(1.5, 10);
  });
});

function row(
  activityId: number,
  sportType: string,
  source: string | null,
  ours: number,
  icu: number,
): ComparisonRow {
  return { activityId, date: "2024-01-01", sportType, source, ours, icu };
}

describe("summarizeComparison", () => {
  it("groups by sport-group x source and computes the stats", () => {
    const rows = [
      row(1, "Run", "pace", 110, 100), // relErr +0.10
      row(2, "Run", "pace", 80, 100), // relErr -0.20
      row(3, "Ride", "power", 200, 180), // separate group
    ];
    const summaries = summarizeComparison(rows);
    expect(summaries).toHaveLength(2);

    const runPace = summaries.find((s) => s.sportGroup === "running" && s.source === "pace");
    expect(runPace?.count).toBe(2);
    expect(runPace?.medianAbsError).toBe(15); // |10| and |20| → median 15
    // signed rel errors +0.10 and -0.20 → mean -0.05
    expect(runPace?.meanSignedRelError).toBeCloseTo(-0.05, 10);

    const ridePower = summaries.find((s) => s.sportGroup === "other" && s.source === "power");
    expect(ridePower?.count).toBe(1);
    expect(ridePower?.medianAbsError).toBe(20);
  });

  it("buckets a null source under 'unknown'", () => {
    const summaries = summarizeComparison([row(1, "Run", null, 100, 90)]);
    expect(summaries[0].source).toBe("unknown");
  });
});

describe("worstOutliers", () => {
  it("returns the n rows with the largest absolute error, descending", () => {
    const rows = [
      row(1, "Run", "pace", 105, 100), // err 5
      row(2, "Run", "pace", 60, 100), // err -40
      row(3, "Run", "pace", 130, 100), // err 30
    ];
    const worst = worstOutliers(rows, 2);
    expect(worst.map((o) => o.activityId)).toEqual([2, 3]);
    expect(worst[0].error).toBe(-40);
  });
});

describe("toComparisonRows", () => {
  const dbRow = (id: number, userId: string, source: string | null) => ({
    id,
    userId,
    startDateLocal: new Date("2026-07-22T18:30:00Z"),
    sportType: "Run",
    source,
    ours: 100,
    icu: 100,
  });

  it("drops excluded users so their zero-error rows leave the report", () => {
    const rows = [
      dbRow(1, "real-user", "hr"),
      dbRow(2, "demo-user", null),
      dbRow(3, "demo-user", null),
    ];
    const kept = toComparisonRows(rows, (userId) => userId === "demo-user");

    expect(kept.map((r) => r.activityId)).toEqual([1]);
    expect(summarizeComparison(kept).some((s) => s.source === "unknown")).toBe(false);
  });

  it("maps the remaining rows and formats the date as YYYY-MM-DD", () => {
    const kept = toComparisonRows([dbRow(7, "real-user", "pace")], () => false);
    expect(kept).toEqual([
      { activityId: 7, date: "2026-07-22", sportType: "Run", source: "pace", ours: 100, icu: 100 },
    ]);
  });
});
