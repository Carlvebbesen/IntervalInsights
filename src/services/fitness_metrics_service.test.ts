import { describe, expect, test } from "bun:test";
import type { DailyLoad } from "../repositories/fitness_metrics_repository";
import { foldFitnessSeries } from "./fitness_metrics_service";

function isoDay(base: string, offset: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe("foldFitnessSeries — single impulse then rest days", () => {
  const loads: DailyLoad[] = [{ date: "2026-01-01", load: 100 }];
  const points = foldFitnessSeries(loads, { from: "2026-01-01", to: "2026-01-15" });

  test("one point per calendar day including rest days", () => {
    expect(points).toHaveLength(15);
    expect(points.map((p) => p.date)).toEqual(
      Array.from({ length: 15 }, (_, i) => isoDay("2026-01-01", i)),
    );
  });

  test("day 1: CTL = 100·(1−e^(−1/42)), ATL = 100·(1−e^(−1/7)), form negative", () => {
    const p0 = points[0];
    expect(p0.ctl).toBeCloseTo(2.352831, 5);
    expect(p0.atl).toBeCloseTo(13.31221, 5);
    expect(p0.tsb).toBeCloseTo(-10.959379, 5);
    expect(p0.load).toBe(100);
    expect(p0.tsb).toBeLessThan(0);
  });

  test("day 2 continues the recursion from day 1", () => {
    expect(points[1].ctl).toBeCloseTo(2.297473, 5);
    expect(points[1].load).toBe(0);
  });

  test("CTL decays as ctl_d·e^(−n/42) on rest days", () => {
    for (let n = 1; n < points.length; n++) {
      expect(points[n].ctl).toBeCloseTo(points[0].ctl * Math.exp(-n / 42), 6);
      expect(points[n].atl).toBeCloseTo(points[0].atl * Math.exp(-n / 7), 6);
    }
  });

  test("tsb is always same-day ctl − atl", () => {
    for (const p of points) expect(p.tsb).toBeCloseTo(p.ctl - p.atl, 10);
  });

  test("rampRate is null for the first 7 days then ctl_d − ctl_{d−7}", () => {
    for (let i = 0; i < 7; i++) expect(points[i].rampRate).toBeNull();
    expect(points[7].rampRate).not.toBeNull();
    expect(points[7].rampRate as number).toBeCloseTo(points[7].ctl - points[0].ctl, 6);
  });
});

describe("foldFitnessSeries — constant load converges toward the load level", () => {
  const loads: DailyLoad[] = Array.from({ length: 400 }, (_, i) => ({
    date: isoDay("2025-01-01", i),
    load: 100,
  }));
  const points = foldFitnessSeries(loads, { from: "2025-01-01", to: isoDay("2025-01-01", 399) });

  test("CTL and ATL both approach 100", () => {
    const last = points[points.length - 1];
    expect(last.ctl).toBeCloseTo(100, 1);
    expect(last.atl).toBeCloseTo(100, 1);
    expect(last.tsb).toBeCloseTo(0, 1);
  });
});

describe("foldFitnessSeries — seeding", () => {
  test("first folded day recurses from the seed value standing at seed.date", () => {
    const loads: DailyLoad[] = [{ date: "2026-01-02", load: 20 }];
    const points = foldFitnessSeries(loads, {
      from: "2026-01-02",
      to: "2026-01-02",
      seed: { date: "2026-01-01", ctl: 50, atl: 30 },
    });
    expect(points).toHaveLength(1);
    expect(points[0].date).toBe("2026-01-02");
    expect(points[0].ctl).toBeCloseTo(49.294151, 5);
    expect(points[0].atl).toBeCloseTo(28.668779, 5);
  });

  test("loads before the seed date are ignored", () => {
    const seed = { date: "2026-01-01", ctl: 50, atl: 30 } as const;
    const withStale: DailyLoad[] = [
      { date: "2025-12-30", load: 999 },
      { date: "2026-01-02", load: 20 },
    ];
    const clean: DailyLoad[] = [{ date: "2026-01-02", load: 20 }];
    const opts = { from: "2026-01-02", to: "2026-01-02", seed };
    expect(foldFitnessSeries(withStale, opts)).toEqual(foldFitnessSeries(clean, opts));
  });

  test("seed extends the ramp window: the 7th folded day resolves rampRate", () => {
    const points = foldFitnessSeries([], {
      from: "2026-01-02",
      to: "2026-01-10",
      seed: { date: "2026-01-01", ctl: 50, atl: 30 },
    });
    // fold days: 01-02 .. 01-10; 01-08 is index 6, d−7 = 01-01 = seed date.
    expect(points.find((p) => p.date === "2026-01-07")?.rampRate).toBeNull();
    const day8 = points.find((p) => p.date === "2026-01-08");
    expect(day8?.rampRate).not.toBeNull();
  });
});

describe("foldFitnessSeries — slicing does not change values", () => {
  test("[from,to] slice matches the same dates in an unsliced fold", () => {
    const loads: DailyLoad[] = [{ date: "2026-01-01", load: 100 }];
    const full = foldFitnessSeries(loads, { from: "2026-01-01", to: "2026-01-20" });
    const sliced = foldFitnessSeries(loads, { from: "2026-01-10", to: "2026-01-20" });
    const fullByDate = new Map(full.map((p) => [p.date, p]));
    for (const p of sliced) {
      const ref = fullByDate.get(p.date);
      expect(ref).toBeDefined();
      expect(p.ctl).toBe(ref?.ctl as number);
      expect(p.atl).toBe(ref?.atl as number);
      expect(p.rampRate).toBe(ref?.rampRate ?? null);
    }
  });

  test("empty history with no seed yields an empty series", () => {
    expect(foldFitnessSeries([], { from: "2026-01-01", to: "2026-01-10" })).toEqual([]);
  });
});
