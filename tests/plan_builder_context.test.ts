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
    ];
    expect(computeBaselineVolume(runs, today)).toEqual({
      trailing4WeekAvgWeeklyMeters: 1500, // only the 6000 run in 28d → /4
      longestRunLast30dMeters: 6000,
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
