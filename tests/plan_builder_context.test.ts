import { describe, expect, it } from "bun:test";
import {
  computeBaselineVolume,
  extractWorkoutVocabulary,
  mapActiveHealthEvents,
} from "../src/agent/planning/nodes/gather_context";
import { DEFAULT_BASELINE_WEEKLY_METERS } from "../src/agent/planning/guards";
import type { EventDao } from "../src/repositories/event_repository";

const today = new Date("2026-02-01T00:00:00Z");
const daysAgo = (n: number) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000);

describe("computeBaselineVolume", () => {
  it("averages the last 28 days over 4 weeks and finds the longest run in 30 days", () => {
    const runs = [
      { startDateLocal: daysAgo(3), distance: 10000 },
      { startDateLocal: daysAgo(10), distance: 8000 },
      { startDateLocal: daysAgo(20), distance: 12000 }, // longest, in 28d + 30d
      { startDateLocal: daysAgo(29), distance: 5000 }, // in 30d but outside 28d
      { startDateLocal: daysAgo(40), distance: 20000 }, // outside both
    ];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: 7500, // (10000+8000+12000)/4
      longestRunLast30dMeters: 12000,
      // Best trailing-4-week slice is weeks 2..5 back: (12000+5000+20000)/4,
      // with 3 active weeks. The proven longest sees the whole 26-week window.
      provenWeeklyMeters: 9250,
      provenLongestRunMeters: 20000,
    });
  });

  it("returns nulls with no runs on record", () => {
    expect(computeBaselineVolume([], today)).toEqual({
      trailing4WeekAvgWeeklyMeters: null,
      longestRunLast30dMeters: null,
      provenWeeklyMeters: null,
      provenLongestRunMeters: null,
    });
  });

  it("accepts string dates / distances and skips runs outside 30 days for the longest", () => {
    const runs = [
      { startDateLocal: daysAgo(40).toISOString(), distance: "9000" },
      { startDateLocal: daysAgo(2).toISOString(), distance: "6000" },
      { startDateLocal: daysAgo(9).toISOString(), distance: "8000" },
      { startDateLocal: daysAgo(16).toISOString(), distance: "10000" },
    ];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: 6000, // (6000+8000+10000)/4; the 40d run is excluded
      longestRunLast30dMeters: 10000,
      provenWeeklyMeters: 6000,
      provenLongestRunMeters: 10000,
    });
  });

  // Thin evidence used to report ABSENT, which handed the plan to the 20 km
  // default and anchored a genuinely low-volume athlete ABOVE what they run.
  // The rule is now: the default applies only with no usable data at all, and
  // real data never yields a baseline above the observed volume.
  it("reports the observed average when the window holds few runs", () => {
    const runs = [
      { startDateLocal: daysAgo(2), distance: 12000 },
      { startDateLocal: daysAgo(9), distance: 14000 },
    ];
    // 2 runs → below MIN_BASELINE_RUNS, but 6.5 km/wk is what they actually ran.
    expect(computeBaselineVolume(runs, today).trailing4WeekAvgWeeklyMeters).toBe(6500);
  });

  it("never anchors a genuinely low-volume athlete above their real volume", () => {
    // The motivating case: 2 x 5 km a month. The old rule called this ABSENT and
    // anchored week 1 at 20 km — about 4x their actual volume.
    const runs = [
      { startDateLocal: daysAgo(4), distance: 5000 },
      { startDateLocal: daysAgo(18), distance: 5000 },
    ];
    const observedWeekly = 10000 / 4;
    const baseline = computeBaselineVolume(runs, today).trailing4WeekAvgWeeklyMeters;
    expect(baseline).toBe(observedWeekly);
    expect(baseline).toBeLessThan(DEFAULT_BASELINE_WEEKLY_METERS);
  });

  it("still reports no baseline when the 28-day window is genuinely empty", () => {
    // Runs on record, but all older than the window: no usable data → default.
    const runs = [{ startDateLocal: daysAgo(45), distance: 12000 }];
    expect(computeBaselineVolume(runs, today).trailing4WeekAvgWeeklyMeters).toBeNull();
  });

  it("never lets a null or unparsable distance contribute a silent zero", () => {
    const runs = [
      { startDateLocal: daysAgo(2), distance: null },
      { startDateLocal: daysAgo(5), distance: "not-a-number" },
      { startDateLocal: daysAgo(9), distance: 10000 },
      { startDateLocal: daysAgo(13), distance: 11000 },
      { startDateLocal: daysAgo(20), distance: 12000 },
    ];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: 8250, // (10000+11000+12000)/4 — the 2 bad rows are skipped
      longestRunLast30dMeters: 12000,
      provenWeeklyMeters: null, // only 2 active weeks — no proven 4-week block
      provenLongestRunMeters: 12000,
    });
  });

  // A single 5 km run in 28 days anchors week 1 at 1.25 km rather than at the
  // 20 km default. Under-anchoring is safe — the ramp grows the plan from there
  // — whereas anchoring 16x above what they ran is the injury case.
  it("anchors a single short run to its own weekly average, not the 20 km default", () => {
    const runs = [{ startDateLocal: daysAgo(3), distance: 5000 }];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: 1250,
      longestRunLast30dMeters: 5000,
      provenWeeklyMeters: null,
      provenLongestRunMeters: 5000,
    });
  });
});

describe("mapActiveHealthEvents", () => {
  const row = (over: Partial<EventDao>): EventDao =>
    ({
      id: 1,
      eventType: "INJURY",
      bodyLocation: null,
      startTime: daysAgo(5),
      lastOccurrence: daysAgo(1),
      status: "active",
      resolvedAt: null,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(1),
      ...over,
    }) as EventDao;

  it("maps active rows (description from the anchor note) and drops resolved ones", () => {
    const out = mapActiveHealthEvents(
      [
        row({ id: 1, eventType: "INJURY", bodyLocation: "left knee" }),
        row({ id: 2, status: "resolved", eventType: "ILLNESS" }),
      ],
      new Map([
        [1, { note: "sore" }],
        [2, { note: "old illness" }],
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "INJURY",
      bodyLocation: "left knee",
      description: "sore",
      since: "2026-01-27",
    });
  });
});

describe("extractWorkoutVocabulary", () => {
  const structureRow = (name: string, activityCount: number, lastDoneAt: Date | string | null) => ({
    name,
    activityCount,
    lastDoneAt,
  });

  it("collects distinct valid types and flags structured-interval history", () => {
    const out = extractWorkoutVocabulary(
      [
        { trainingType: "EASY" },
        { trainingType: "EASY" },
        { trainingType: "LONG" },
        { trainingType: "LONG_INTERVALS" },
        { trainingType: null },
        { trainingType: "UNCLASSIFIED" },
      ],
      [],
    );
    expect(new Set(out.types)).toEqual(new Set(["EASY", "LONG", "LONG_INTERVALS"]));
    expect(out.hasStructuredIntervalHistory).toBe(true);
    expect(out.structures).toEqual([]);
  });

  it("does not treat continuous TEMPO as structured-interval history", () => {
    const out = extractWorkoutVocabulary([{ trainingType: "EASY" }, { trainingType: "TEMPO" }], []);
    expect(out.hasStructuredIntervalHistory).toBe(false);
  });

  it("honours structure rows even without interval training types", () => {
    const out = extractWorkoutVocabulary(
      [{ trainingType: "EASY" }],
      [structureRow("5x1000m", 3, daysAgo(10))],
    );
    expect(out.hasStructuredIntervalHistory).toBe(true);
  });

  it("keeps the top 8 structures by activity count, then recency, dates as ISO strings", () => {
    const rows = [
      structureRow("least-done", 1, daysAgo(1)),
      ...Array.from({ length: 8 }, (_, i) =>
        structureRow(`shape-${i}`, 10 - i, daysAgo(30 + i)),
      ),
      structureRow("tie-older", 10, daysAgo(20)),
    ];
    const out = extractWorkoutVocabulary([], rows);
    expect(out.structures).toHaveLength(8);
    // Ties on activityCount break by recency: tie-older (10x, 20d ago) beats shape-0 (10x, 30d ago).
    expect(out.structures[0]).toEqual({
      name: "tie-older",
      activityCount: 10,
      lastDoneAt: "2026-01-12",
    });
    expect(out.structures[1].name).toBe("shape-0");
    expect(out.structures.map((s) => s.name)).not.toContain("least-done");
    expect(out.structures[2]).toEqual({
      name: "shape-1",
      activityCount: 9,
      lastDoneAt: "2026-01-01",
    });
  });

  it("accepts string dates and null lastDoneAt", () => {
    const out = extractWorkoutVocabulary(
      [],
      [structureRow("a", 2, daysAgo(5).toISOString()), structureRow("b", 2, null)],
    );
    expect(out.structures[0].name).toBe("a");
    expect(out.structures[1]).toEqual({ name: "b", activityCount: 2, lastDoneAt: null });
  });
});
