// Pure-function coverage for the D6 ingest gate + D3 sport→gear mapping.

import { describe, expect, it } from "bun:test";
import { gearContextForActivity } from "../src/schema";
import { shouldAnalyze } from "../src/services/utils";

describe("shouldAnalyze (D6 canonical camelCase gate)", () => {
  it("passes the sports the old spaced-string list silently dropped", () => {
    for (const sport of ["VirtualRide", "NordicSki", "BackcountrySki"]) {
      expect(shouldAnalyze(sport)).toBe(true);
    }
  });

  it("passes the full widened import+analyze set", () => {
    for (const sport of [
      "Run",
      "TrailRun",
      "VirtualRun",
      "Ride",
      "VirtualRide",
      "EBikeRide",
      "GravelRide",
      "MountainBikeRide",
      "NordicSki",
      "BackcountrySki",
      "RollerSki",
      "Elliptical",
      "Hike",
      "Rowing",
    ]) {
      expect(shouldAnalyze(sport)).toBe(true);
    }
  });

  it("rejects unlisted sports and the legacy spaced strings", () => {
    for (const sport of ["Swim", "Walk", "Nordic Ski", "Virtual Ride", "Backcountry Ski"]) {
      expect(shouldAnalyze(sport)).toBe(false);
    }
  });
});

describe("gearContextForActivity (D3)", () => {
  it("maps runs to shoes with an indoor-aware surface", () => {
    expect(gearContextForActivity("TrailRun", false)).toEqual({ gearType: "SHOES", surface: "TRAIL" });
    expect(gearContextForActivity("Run", true)).toEqual({ gearType: "SHOES", surface: "TREADMILL" });
    expect(gearContextForActivity("VirtualRun", true)).toEqual({
      gearType: "SHOES",
      surface: "TREADMILL",
    });
    expect(gearContextForActivity("Run", false)).toEqual({ gearType: "SHOES", surface: "ROAD" });
  });

  it("maps rides to bicycles with a per-discipline surface", () => {
    expect(gearContextForActivity("Ride", false)).toEqual({ gearType: "BICYCLE", surface: "ROAD" });
    expect(gearContextForActivity("EBikeRide", false)).toEqual({
      gearType: "BICYCLE",
      surface: "ROAD",
    });
    expect(gearContextForActivity("GravelRide", false)).toEqual({
      gearType: "BICYCLE",
      surface: "GRAVEL",
    });
    expect(gearContextForActivity("MountainBikeRide", false)).toEqual({
      gearType: "BICYCLE",
      surface: "MTB",
    });
  });

  it("maps skis to SKIS (no on-snow surface) and rollerski to ROLLERSKI", () => {
    expect(gearContextForActivity("NordicSki", false)).toEqual({ gearType: "SKIS", surface: null });
    expect(gearContextForActivity("BackcountrySki", false)).toEqual({
      gearType: "SKIS",
      surface: null,
    });
    expect(gearContextForActivity("RollerSki", false)).toEqual({
      gearType: "SKIS",
      surface: "ROLLERSKI",
    });
  });

  it("returns null for sports with no gear context", () => {
    expect(gearContextForActivity("Swim", false)).toBeNull();
    expect(gearContextForActivity("Walk", false)).toBeNull();
  });
});
