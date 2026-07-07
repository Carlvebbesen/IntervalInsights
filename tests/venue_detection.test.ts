import { describe, expect, it } from "bun:test";
import type { LatLng, StreamSet } from "../src/types/strava/IStream";
import { resolveVenueContext } from "../src/services/venue_detection_service";

const NG: LatLng = [59.938758, 10.74794];
const BISLETT: LatLng = [59.925024, 10.7334];
const FAR: LatLng = [59.911491, 10.75733]; // central Oslo, ~2 km from both

const streamsFrom = (data: LatLng[]): StreamSet =>
  ({ latlng: { data } }) as unknown as StreamSet;

// Jitter a centre point by a few metres so a loop reads as many nearby samples.
const near = (c: LatLng, n: number): LatLng[] =>
  Array.from({ length: n }, (_, i) => [c[0] + (i % 5) * 0.0002, c[1] + (i % 3) * 0.0002]);

describe("resolveVenueContext", () => {
  it("confirms NG when the session sits on the loop", () => {
    expect(resolveVenueContext(streamsFrom(near(NG, 100)))).toEqual({
      confirmedTokens: ["NG"],
      hasGps: true,
    });
  });

  it("confirms Bislett for a session at the stadium", () => {
    expect(resolveVenueContext(streamsFrom(near(BISLETT, 100)))).toEqual({
      confirmedTokens: ["BSL"],
      hasGps: true,
    });
  });

  it("confirms nothing but reports GPS present for a run elsewhere", () => {
    // hasGps:true is the veto signal — a venue-length rep here must NOT snap.
    expect(resolveVenueContext(streamsFrom(near(FAR, 100)))).toEqual({
      confirmedTokens: [],
      hasGps: true,
    });
  });

  it("reports no GPS when there is no latlng stream (indoor / GPS off)", () => {
    expect(resolveVenueContext({} as StreamSet)).toEqual({ confirmedTokens: [], hasGps: false });
    expect(resolveVenueContext(null)).toEqual({ confirmedTokens: [], hasGps: false });
  });

  it("ignores null-island (0,0) padding points", () => {
    const data: LatLng[] = [...near(NG, 80), ...Array.from({ length: 20 }, () => [0, 0] as LatLng)];
    expect(resolveVenueContext(streamsFrom(data)).confirmedTokens).toEqual(["NG"]);
  });
});
