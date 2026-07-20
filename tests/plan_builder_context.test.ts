import { describe, expect, it } from "bun:test";
import {
  computeBaselineVolume,
  extractWorkoutVocabulary,
  mapActiveHealthEvents,
} from "../src/agent/planning/nodes/gather_context";
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
    });
  });

  it("returns nulls with no runs on record", () => {
    expect(computeBaselineVolume([], today)).toEqual({
      trailing4WeekAvgWeeklyMeters: null,
      longestRunLast30dMeters: null,
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
    });
  });

  it("reports no baseline when the 28-day window holds too few runs", () => {
    const runs = [
      { startDateLocal: daysAgo(2), distance: 12000 },
      { startDateLocal: daysAgo(9), distance: 14000 },
    ];
    // 2 runs → below MIN_BASELINE_RUNS: a 6.5 km/wk average off 2 runs is an
    // artefact of dividing by 4, not a training baseline.
    expect(computeBaselineVolume(runs, today).trailing4WeekAvgWeeklyMeters).toBeNull();
  });

  it("reports no baseline when the computed average is implausibly low", () => {
    const runs = [1, 5, 9, 13].map((n) => ({ startDateLocal: daysAgo(n), distance: 1000 }));
    // 4 runs but only 1 km/wk — treat as absent so the 20 km default anchors.
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
    });
  });

  it("a single short run yields no baseline rather than a 1.25 km week", () => {
    const runs = [{ startDateLocal: daysAgo(3), distance: 5000 }];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: null,
      longestRunLast30dMeters: 5000,
    });
  });
});

describe("mapActiveHealthEvents", () => {
  const row = (over: Partial<EventDao>): EventDao =>
    ({
      id: 1,
      eventType: "INJURY",
      bodyLocation: null,
      description: "",
      startTime: daysAgo(5),
      lastOccurrence: daysAgo(1),
      status: "active",
      resolvedAt: null,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(1),
      ...over,
    }) as EventDao;

  it("maps active rows and drops resolved ones", () => {
    const out = mapActiveHealthEvents([
      row({ eventType: "INJURY", bodyLocation: "left knee", description: "sore" }),
      row({ status: "resolved", description: "old illness", eventType: "ILLNESS" }),
    ]);
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
      false,
    );
    expect(new Set(out.types)).toEqual(new Set(["EASY", "LONG", "LONG_INTERVALS"]));
    expect(out.hasStructuredIntervalHistory).toBe(true);
  });

  it("does not treat continuous TEMPO as structured-interval history", () => {
    const out = extractWorkoutVocabulary([{ trainingType: "EASY" }, { trainingType: "TEMPO" }], false);
    expect(out.hasStructuredIntervalHistory).toBe(false);
  });

  it("honours the structures flag even without interval training types", () => {
    const out = extractWorkoutVocabulary([{ trainingType: "EASY" }], true);
    expect(out.hasStructuredIntervalHistory).toBe(true);
  });
});
