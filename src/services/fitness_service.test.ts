import { describe, expect, test } from "bun:test";
import type { IHrvBaseline } from "../types/intervals/IFitness";
import { classifyHrv, computeHrvAssessment } from "./fitness_service";

const DAY_MS = 86_400_000;

function seriesEndingAt(targetDate: string, dailyHrv: (number | null)[]): Map<string, number> {
  const map = new Map<string, number>();
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const n = dailyHrv.length;
  for (let i = 0; i < n; i++) {
    const v = dailyHrv[i];
    if (v == null) continue;
    const daysAgo = n - 1 - i;
    map.set(new Date(target - daysAgo * DAY_MS).toISOString().slice(0, 10), v);
  }
  return map;
}

describe("classifyHrv (Garmin per-day rule: 7d-avg inside band = balanced, outside = unbalanced)", () => {
  const garminRows: Array<{
    date: string;
    avg: number;
    low: number;
    high: number;
    expected: "balanced" | "unbalanced";
  }> = [
    { date: "May 28", avg: 67, low: 68, high: 107, expected: "unbalanced" },
    { date: "May 27", avg: 71, low: 68, high: 108, expected: "balanced" },
    { date: "May 26", avg: 72, low: 68, high: 108, expected: "balanced" },
    { date: "May 25", avg: 75, low: 68, high: 107, expected: "balanced" },
    { date: "May 24", avg: 73, low: 67, high: 109, expected: "balanced" },
    { date: "May 23", avg: 73, low: 67, high: 109, expected: "balanced" },
    { date: "May 22", avg: 72, low: 67, high: 109, expected: "balanced" },
    { date: "May 21", avg: 81, low: 67, high: 109, expected: "balanced" },
    { date: "May 20", avg: 81, low: 67, high: 109, expected: "balanced" },
    { date: "May 19", avg: 76, low: 67, high: 110, expected: "balanced" },
    { date: "May 18", avg: 77, low: 67, high: 109, expected: "balanced" },
    { date: "May 17", avg: 80, low: 67, high: 110, expected: "balanced" },
    { date: "May 16", avg: 69, low: 68, high: 108, expected: "balanced" },
    { date: "May 15", avg: 70, low: 68, high: 108, expected: "balanced" },
    { date: "May 14", avg: 70, low: 68, high: 108, expected: "balanced" },
    { date: "May 13", avg: 68, low: 69, high: 109, expected: "unbalanced" },
    { date: "May 12", avg: 67, low: 68, high: 109, expected: "unbalanced" },
    { date: "May 11", avg: 64, low: 68, high: 109, expected: "unbalanced" },
    { date: "May 10", avg: 61, low: 69, high: 110, expected: "unbalanced" },
    { date: "May 9", avg: 68, low: 69, high: 110, expected: "unbalanced" },
    { date: "May 8", avg: 65, low: 69, high: 110, expected: "unbalanced" },
    { date: "May 7", avg: 62, low: 69, high: 111, expected: "unbalanced" },
    { date: "May 6", avg: 64, low: 69, high: 111, expected: "unbalanced" },
    { date: "May 5", avg: 68, low: 69, high: 111, expected: "unbalanced" },
    { date: "May 4", avg: 70, low: 69, high: 111, expected: "balanced" },
    { date: "May 2", avg: 75, low: 69, high: 111, expected: "balanced" },
    { date: "May 1", avg: 74, low: 70, high: 111, expected: "balanced" },
  ];

  for (const row of garminRows) {
    test(`${row.date}: 7d-avg ${row.avg} vs ${row.low}-${row.high} → ${row.expected}`, () => {
      const baseline: IHrvBaseline = {
        mean: (row.low + row.high) / 2,
        lowerBalanced: row.low,
        upperBalanced: row.high,
      };
      expect(classifyHrv(row.avg, baseline)).toBe(row.expected);
    });
  }

  test("nightly value and 7-day average classify independently against the same band", () => {
    const band: IHrvBaseline = { mean: 75, lowerBalanced: 60, upperBalanced: 90 };
    const sevenDayAvg = 74;
    const noisyNight = 45;
    expect(classifyHrv(sevenDayAvg, band)).toBe("balanced");
    expect(classifyHrv(noisyNight, band)).toBe("unbalanced");
  });

  test("band edges are inclusive (a value exactly on the bound is balanced)", () => {
    const band: IHrvBaseline = { mean: 88, lowerBalanced: 68, upperBalanced: 108 };
    expect(classifyHrv(68, band)).toBe("balanced");
    expect(classifyHrv(108, band)).toBe("balanced");
    expect(classifyHrv(67.99, band)).toBe("unbalanced");
    expect(classifyHrv(108.01, band)).toBe("unbalanced");
  });
});

describe("computeHrvAssessment (baseline must be slow-moving so dips surface)", () => {
  const TARGET = "2026-05-28";

  test("insufficient history → status & baseline null", () => {
    const series = seriesEndingAt(TARGET, [70, 72, 68, 74, 71]);
    const a = computeHrvAssessment(series, TARGET);
    expect(a.status).toBeNull();
    expect(a.baseline).toBeNull();
    expect(a.rollingAvg).not.toBeNull();
  });

  test("recent average inside a stable band → balanced", () => {
    const daily = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 85 : 91));
    const a = computeHrvAssessment(seriesEndingAt(TARGET, daily), TARGET);
    expect(a.status).toBe("balanced");
    expect(a.baseline).not.toBeNull();
  });

  test("declining HRV (high baseline, recent drop) → unbalanced — the all-green bug", () => {
    const daily = [...Array(83).fill(95), ...Array(7).fill(68)];
    const a = computeHrvAssessment(seriesEndingAt(TARGET, daily), TARGET);
    expect(a.status).toBe("unbalanced");
    expect(a.rollingAvg).toBeCloseTo(68, 5);
    expect(a.baseline?.lowerBalanced).toBeGreaterThan(a.rollingAvg ?? 0);
  });

  test("recent spike well above baseline → unbalanced (outside on the high side)", () => {
    const daily = [...Array(83).fill(70), ...Array(7).fill(110)];
    const a = computeHrvAssessment(seriesEndingAt(TARGET, daily), TARGET);
    expect(a.status).toBe("unbalanced");
    expect(a.baseline?.upperBalanced).toBeLessThan(a.rollingAvg ?? Number.POSITIVE_INFINITY);
  });

  test("baseline never emits 'low' per-day (only balanced/unbalanced/null)", () => {
    const daily = [...Array(83).fill(95), ...Array(7).fill(40)];
    const a = computeHrvAssessment(seriesEndingAt(TARGET, daily), TARGET);
    expect(a.status).toBe("unbalanced");
  });
});
