import { describe, expect, it } from "bun:test";
import {
  extractIntervalsList,
  mapIntervalsActivityToInsert,
  mapIntervalsRawToLaps,
  mapIntervalsStreamsToStreamSet,
} from "../src/services/intervals_mappers";
import { synthIntervalsActivity } from "./helpers/intervals_fixtures";

describe("mapIntervalsActivityToInsert", () => {
  it("produces a null-Strava insert carrying the intervals.icu id", () => {
    const a = synthIntervalsActivity({ distance: 7200, name: "Tempo" });
    const insert = mapIntervalsActivityToInsert(a, "user-1", true);

    expect(insert.stravaActivityId).toBeNull();
    expect(insert.intervalsIcuId).toBe(a.id);
    expect(insert.userId).toBe("user-1");
    expect(insert.title).toBe("Tempo");
    expect(insert.distance).toBe(7200);
    expect(insert.indoor).toBe(false);
    expect(insert.startDateLocal instanceof Date).toBe(true);
  });

  it("parses intervals.icu's naive local time as a UTC instant", () => {
    const a = synthIntervalsActivity({ start_date_local: "2026-05-01T08:00:00" });
    const insert = mapIntervalsActivityToInsert(a, "u", true);
    expect(insert.startDateLocal.toISOString()).toBe("2026-05-01T08:00:00.000Z");
  });

  it("coalesces the NOT NULL columns when intervals.icu omits them (no-distance indoor sports)", () => {
    // intervals.icu returns distance/moving_time/name null for elliptical, strength,
    // pool swim, virtual ride — which previously violated the NOT NULL constraints.
    const a = synthIntervalsActivity({
      distance: null,
      moving_time: null,
      name: null,
      type: "Elliptical",
    });
    const insert = mapIntervalsActivityToInsert(a, "u", true);
    expect(insert.distance).toBe(0);
    expect(insert.movingTime).toBe(0);
    expect(insert.title).toBe("Untitled activity");
    expect(insert.sportType).toBe("Elliptical");
  });

  it("carries HR and sets hasHeartrate when consent is granted", () => {
    const a = synthIntervalsActivity({ average_heartrate: 150 });
    const insert = mapIntervalsActivityToInsert(a, "u", true);
    expect(insert.averageHeartRate).toBe(150);
    expect(insert.hasHeartrate).toBe(true);
  });

  it("nulls HR and clears hasHeartrate when consent is withheld (GDPR gate)", () => {
    const a = synthIntervalsActivity({ average_heartrate: 150, max_heartrate: 175 });
    const insert = mapIntervalsActivityToInsert(a, "u", false);
    expect(insert.averageHeartRate).toBeNull();
    expect(insert.hasHeartrate).toBe(false);
  });
});

describe("mapIntervalsStreamsToStreamSet", () => {
  it("maps intervals.icu stream keys onto the internal StreamSet and ignores unknowns", () => {
    const set = mapIntervalsStreamsToStreamSet([
      { type: "heartrate", data: [120, 130, 140] },
      { type: "velocity_smooth", data: [3.0, 3.2] },
      { type: "watts", data: [200, 210] },
      { type: "time", data: [0, 1, 2] },
      { type: "totally_unknown", data: [1] },
    ]);

    expect(set.heartrate?.data).toEqual([120, 130, 140]);
    expect(set.velocity_smooth?.data).toEqual([3.0, 3.2]);
    expect(set.watts?.data).toEqual([200, 210]);
    expect(set.time?.data).toEqual([0, 1, 2]);
    expect("totally_unknown" in set).toBe(false);
  });

  it("zips the split latlng stream (data=lat, data2=lng) into tuples", () => {
    const set = mapIntervalsStreamsToStreamSet([
      { type: "latlng", data: [59.9388, 59.9389], data2: [10.7479, 10.748] },
    ]);
    expect(set.latlng?.data).toEqual([
      [59.9388, 10.7479],
      [59.9389, 10.748],
    ]);
  });

  it("accepts a latlng stream already in [lat,lng] tuple form", () => {
    const set = mapIntervalsStreamsToStreamSet([
      { type: "latlng", data: [[59.9388, 10.7479]] },
    ]);
    expect(set.latlng?.data).toEqual([[59.9388, 10.7479]]);
  });

  it("skips a latlng stream missing its longitude half", () => {
    const set = mapIntervalsStreamsToStreamSet([{ type: "latlng", data: [59.9388] }]);
    expect("latlng" in set).toBe(false);
  });

  it("returns an empty set for a non-array input", () => {
    expect(mapIntervalsStreamsToStreamSet(null)).toEqual({});
  });
});

describe("extractIntervalsList", () => {
  it("unwraps icu_intervals, accepts bare arrays, and tolerates junk", () => {
    expect(extractIntervalsList({ icu_intervals: [{ id: 1 }] })).toHaveLength(1);
    expect(extractIntervalsList([{ id: 2 }])).toHaveLength(1);
    expect(extractIntervalsList(null)).toEqual([]);
    expect(extractIntervalsList({})).toEqual([]);
  });
});

describe("mapIntervalsRawToLaps", () => {
  it("maps interval boundaries onto the Strava Lap shape lap derivation expects", () => {
    const laps = mapIntervalsRawToLaps({
      icu_intervals: [
        {
          id: 1,
          distance: 400,
          moving_time: 90,
          start_index: 0,
          end_index: 90,
          average_heartrate: 170,
        },
      ],
    });

    expect(laps).toHaveLength(1);
    expect(laps[0].distance).toBe(400);
    expect(laps[0].moving_time).toBe(90);
    expect(laps[0].average_speed).toBeCloseTo(400 / 90);
    expect(laps[0].average_heartrate).toBe(170);
    expect(laps[0].start_index).toBe(0);
    expect(laps[0].end_index).toBe(90);
  });
});
