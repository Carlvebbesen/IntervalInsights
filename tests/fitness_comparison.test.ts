import { describe, expect, it } from "bun:test";
import {
  alignSeries,
  latestPerDay,
  type SeriesPoint,
  summarizeByYear,
} from "../scripts/_fitness_comparison";

describe("alignSeries", () => {
  it("inner-joins by date and computes ours − reference deltas", () => {
    const ours: SeriesPoint[] = [
      { date: "2025-12-31", ctl: 50, atl: 40 },
      { date: "2026-01-01", ctl: 52, atl: 45 },
      { date: "2026-01-02", ctl: 54, atl: 48 },
    ];
    const ref: SeriesPoint[] = [
      { date: "2026-01-01", ctl: 50, atl: 42 },
      { date: "2026-01-02", ctl: 51, atl: 50 },
      { date: "2026-01-03", ctl: 60, atl: 55 },
    ];
    const deltas = alignSeries(ours, ref);
    expect(deltas.map((d) => d.date)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(deltas[0]).toEqual({ date: "2026-01-01", year: 2026, dCtl: 2, dAtl: 3 });
    expect(deltas[1]).toEqual({ date: "2026-01-02", year: 2026, dCtl: 3, dAtl: -2 });
  });
});

describe("summarizeByYear", () => {
  it("splits by calendar year and appends an all-years row", () => {
    const deltas = [
      { date: "2025-06-01", year: 2025, dCtl: 2, dAtl: 4 },
      { date: "2025-06-02", year: 2025, dCtl: -4, dAtl: -2 },
      { date: "2026-01-01", year: 2026, dCtl: 10, dAtl: 0 },
    ];
    const rows = summarizeByYear(deltas);
    expect(rows.map((r) => r.year)).toEqual([2025, 2026, "all"]);

    const y2025 = rows[0];
    expect(y2025.count).toBe(2);
    expect(y2025.medAbsCtl).toBe(3); // median(|2|,|-4|) = median(2,4) = 3
    expect(y2025.meanSignedCtl).toBe(-1); // (2 + -4)/2

    const all = rows[2];
    expect(all.count).toBe(3);
    expect(all.meanSignedCtl).toBeCloseTo((2 - 4 + 10) / 3, 10);
  });

  it("returns an empty array for no deltas", () => {
    expect(summarizeByYear([])).toEqual([]);
  });
});

describe("latestPerDay", () => {
  it("keeps the last point per date, sorted ascending", () => {
    const points: SeriesPoint[] = [
      { date: "2026-01-02", ctl: 1, atl: 1 },
      { date: "2026-01-01", ctl: 2, atl: 2 },
      { date: "2026-01-02", ctl: 9, atl: 9 },
    ];
    expect(latestPerDay(points)).toEqual([
      { date: "2026-01-01", ctl: 2, atl: 2 },
      { date: "2026-01-02", ctl: 9, atl: 9 },
    ]);
  });
});
