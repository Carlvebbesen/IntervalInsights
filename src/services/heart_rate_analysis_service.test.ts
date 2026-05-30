import { describe, expect, test } from "bun:test";
import type { HrAnalysisRow } from "../repositories/activity_repository";
import type { IIntervalsAthlete } from "../types/intervals/IIntervalsActivity";
import {
  buildHrZones,
  buildSummaries,
  normalizeIntervalsStreams,
  toPoint,
} from "./heart_rate_analysis_service";

function row(overrides: Partial<HrAnalysisRow>): HrAnalysisRow {
  return {
    id: 1,
    startDateLocal: new Date("2026-05-12T06:30:00.000Z"),
    title: "Run",
    trainingType: "LONG",
    stravaActivityId: 999,
    hasHeartrate: true,
    averageHeartRate: 145,
    maxHeartRate: 178,
    medianHeartRate: 148,
    modeHeartRate: 150,
    workAvgHeartRate: 162,
    workMaxHeartRate: 188,
    workMedianHeartRate: 165,
    workModeHeartRate: 170,
    hrStatsComputedAt: new Date(),
    ...overrides,
  } as HrAnalysisRow;
}

describe("toPoint", () => {
  test("maps whole-activity columns when intervalsOnly is false", () => {
    expect(toPoint(row({}), false)).toEqual({
      activityId: 1,
      date: "2026-05-12T06:30:00.000Z",
      name: "Run",
      trainingType: "LONG",
      avgHr: 145,
      maxHr: 178,
      medianHr: 148,
      modeHr: 150,
    });
  });

  test("maps work-interval columns when intervalsOnly is true", () => {
    const p = toPoint(row({}), true);
    expect(p).toMatchObject({ avgHr: 162, maxHr: 188, medianHr: 165, modeHr: 170 });
  });

  test("rounds fractional stored values and tolerates nulls", () => {
    const p = toPoint(
      row({
        averageHeartRate: 145.6,
        maxHeartRate: null,
        medianHeartRate: null,
        modeHeartRate: null,
      }),
      false,
    );
    expect(p.avgHr).toBe(146);
    expect(p.maxHr).toBeNull();
    expect(p.medianHr).toBeNull();
    expect(p.modeHr).toBeNull();
  });

  test("emits null trainingType when absent", () => {
    expect(toPoint(row({ trainingType: null }), false).trainingType).toBeNull();
  });

  test("intervalsOnly yields null metrics when work stats were never computed", () => {
    const p = toPoint(
      row({
        workAvgHeartRate: null,
        workMaxHeartRate: null,
        workMedianHeartRate: null,
        workModeHeartRate: null,
      }),
      true,
    );
    expect(p).toMatchObject({ avgHr: null, maxHr: null, medianHr: null, modeHr: null });
  });
});

describe("buildSummaries", () => {
  const points = [
    {
      activityId: 123,
      date: "",
      name: "",
      trainingType: null,
      avgHr: 145,
      maxHr: 178,
      medianHr: 148,
      modeHr: 150,
    },
    {
      activityId: 140,
      date: "",
      name: "",
      trainingType: null,
      avgHr: 162,
      maxHr: 188,
      medianHr: 165,
      modeHr: 170,
    },
  ];

  test("computes min/max with owning activityId and mean per metric", () => {
    const s = buildSummaries(points);
    expect(s.avgHr).toEqual({
      min: { activityId: 123, value: 145 },
      max: { activityId: 140, value: 162 },
      mean: 153.5,
    });
    expect(s.maxHr.mean).toBe(183);
    expect(s.maxHr.min).toEqual({ activityId: 123, value: 178 });
    expect(s.maxHr.max).toEqual({ activityId: 140, value: 188 });
  });

  test("min/max reference an activityId that exists in points", () => {
    const s = buildSummaries(points);
    const ids = new Set(points.map((p) => p.activityId));
    for (const metric of Object.values(s)) {
      if (metric.min) expect(ids.has(metric.min.activityId)).toBe(true);
      if (metric.max) expect(ids.has(metric.max.activityId)).toBe(true);
    }
  });

  test("skips null values and omits a metric entirely when no point has it", () => {
    const s = buildSummaries([
      {
        activityId: 1,
        date: "",
        name: "",
        trainingType: null,
        avgHr: 150,
        maxHr: null,
        medianHr: null,
        modeHr: null,
      },
      {
        activityId: 2,
        date: "",
        name: "",
        trainingType: null,
        avgHr: null,
        maxHr: null,
        medianHr: null,
        modeHr: null,
      },
    ]);
    expect(s.avgHr).toEqual({
      min: { activityId: 1, value: 150 },
      max: { activityId: 1, value: 150 },
      mean: 150,
    });
    expect(s.maxHr).toBeUndefined();
    expect(s.medianHr).toBeUndefined();
    expect(s.modeHr).toBeUndefined();
  });

  test("returns an empty object for no points", () => {
    expect(buildSummaries([])).toEqual({});
  });
});

describe("buildHrZones", () => {
  function athlete(sportSettings: IIntervalsAthlete["sportSettings"]): IIntervalsAthlete {
    return {
      id: "a1",
      name: null,
      email: null,
      weight: null,
      ftp: null,
      lthr: null,
      timezone: null,
      sportSettings,
    };
  }

  test("builds ascending bands from the running profile, dropping a leading 0", () => {
    const zones = buildHrZones(
      athlete([
        {
          types: ["Ride"],
          hr_zones: [110, 140, 170],
          hr_zone_names: ["A", "B", "C"],
          lthr: null,
          max_hr: null,
        },
        {
          types: ["Run", "TrailRun"],
          hr_zones: [0, 123, 142, 160, 178, 197],
          hr_zone_names: ["Z1", "Z2", "Z3", "Z4", "Z5"],
          lthr: 165,
          max_hr: 197,
        },
      ]),
    );
    expect(zones).toEqual([
      { label: "Z1", min: 0, max: 123, color: "#22C55E" },
      { label: "Z2", min: 123, max: 142, color: "#3B82F6" },
      { label: "Z3", min: 142, max: 160, color: "#F59E0B" },
      { label: "Z4", min: 160, max: 178, color: "#EF4444" },
      { label: "Z5", min: 178, max: 197, color: "#7C3AED" },
    ]);
  });

  test("falls back to Z{n} labels when names are missing", () => {
    const zones = buildHrZones(
      athlete([
        { types: ["Run"], hr_zones: [120, 150], hr_zone_names: null, lthr: null, max_hr: null },
      ]),
    );
    expect(zones.map((z) => z.label)).toEqual(["Z1", "Z2"]);
  });

  test("falls back to the first profile with HR zones when no running profile matches", () => {
    const zones = buildHrZones(
      athlete([
        {
          types: ["Ride"],
          hr_zones: [100, 130],
          hr_zone_names: ["A", "B"],
          lthr: null,
          max_hr: null,
        },
      ]),
    );
    expect(zones.map((z) => z.max)).toEqual([100, 130]);
  });

  test("returns [] when there are no zones or no sportSettings", () => {
    expect(buildHrZones(athlete(null))).toEqual([]);
    expect(buildHrZones(athlete([]))).toEqual([]);
    expect(
      buildHrZones(
        athlete([
          { types: ["Run"], hr_zones: null, hr_zone_names: null, lthr: null, max_hr: null },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("normalizeIntervalsStreams", () => {
  test("maps an array of {type,data} stream objects into heartrate/time", () => {
    const out = normalizeIntervalsStreams([
      { type: "time", data: [0, 1, 2] },
      { type: "heartrate", data: [120, 130, 140] },
      { type: "watts", data: [200, 210, 220] },
    ]);
    expect(out.heartrate?.data).toEqual([120, 130, 140]);
    expect(out.time?.data).toEqual([0, 1, 2]);
  });

  test("ignores entries without an array data field", () => {
    const out = normalizeIntervalsStreams([{ type: "heartrate", data: null }, { type: "time" }]);
    expect(out.heartrate).toBeUndefined();
    expect(out.time).toBeUndefined();
  });

  test("returns an empty object for non-array input", () => {
    expect(normalizeIntervalsStreams(null)).toEqual({});
    expect(normalizeIntervalsStreams({ heartrate: [1, 2] })).toEqual({});
  });
});
