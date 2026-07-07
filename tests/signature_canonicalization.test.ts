import { describe, expect, it } from "bun:test";
import type { InsertIntervalSegment } from "../src/schema";
import {
  canonicalizeComponents,
  generateIntervalSignature,
  generateStructureName,
  type IntervalComponent,
  mapSegmentsToComponents,
  type VenueContext,
} from "../src/services/interval_structure_service";

const m = (value: number): IntervalComponent => ({ value, unit: "m" });
const s = (value: number): IntervalComponent => ({ value, unit: "sec" });

describe("generateIntervalSignature — canonicalization", () => {
  // Each case mirrors a row from the 2026-07-07 prod interval_structures dump.
  const cases: Array<{ name: string; components: IntervalComponent[]; expected: string }> = [
    {
      name: "id 24 — zero/custom segment dropped (0s-360s → 360s)",
      components: [s(360), s(0)],
      expected: "360s",
    },
    {
      name: "id 25 — measured NG laps snap to the venue token",
      components: [1509, 1513, 1518, 1528, 1534].map(m),
      expected: "NG",
    },
    {
      name: "id 15 — long measured distances quantize to nearest 500 m",
      components: [4019.27, 4015.5, 4031.17, 4078.63, 4010.94].map(m),
      expected: "4000m",
    },
    {
      name: "id 18 — mixed measured longs collapse (1000m + 4000m)",
      components: [4001.56, 1000.85, 1003.59, 1001.67, 1000.01].map(m),
      expected: "1000m-4000m",
    },
    {
      name: "id 5 — clean prescription is preserved",
      components: [1000, 2000, 3000].map(m),
      expected: "1000m-2000m-3000m",
    },
    {
      name: "id 10 — mixed distance + time",
      components: [m(1000), s(45)],
      expected: "1000m-45s",
    },
    {
      name: "prescribed 1500 m stays 1500 m (inside NG tolerance but round → no snap)",
      components: [1500, 1500, 1500].map(m),
      expected: "1500m",
    },
    {
      name: "measured Bislett laps snap to BSL",
      components: [546.5, 545.8, 547.2].map(m),
      expected: "BSL",
    },
    {
      name: "outdoor 400 m track never snaps to Bislett",
      components: [400, 400, 400].map(m),
      expected: "400m",
    },
    {
      name: "duplicate reps dedup to one part",
      components: [1000, 1000, 1000, 1000].map(m),
      expected: "1000m",
    },
    {
      name: "empty / all-dropped → empty signature",
      components: [s(0), { value: 0, unit: "m" }],
      expected: "",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(generateIntervalSignature(c.components)).toBe(c.expected);
    });
  }

  it("GPS confirmation lets a round venue distance snap", () => {
    const venue: VenueContext = { confirmedTokens: ["NG"], hasGps: true };
    expect(generateIntervalSignature([1500, 1500].map(m))).toBe("1500m");
    expect(generateIntervalSignature([1500, 1500].map(m), venue)).toBe("NG");
  });

  it("GPS confirmation never overrides distance (out-of-tolerance stays put)", () => {
    const venue: VenueContext = { confirmedTokens: ["NG"], hasGps: true };
    expect(generateIntervalSignature([2000, 2000].map(m), venue)).toBe("2000m");
  });

  it("GPS present but unconfirmed vetoes a measured venue snap", () => {
    // Without GPS these ~1500 m measured reps snap to NG (distance-only). With a
    // GPS track that is NOT at NG, they must fall back to a plain distance.
    const elsewhere: VenueContext = { confirmedTokens: [], hasGps: true };
    expect(generateIntervalSignature([1509, 1513].map(m))).toBe("NG");
    expect(generateIntervalSignature([1509, 1513].map(m), elsewhere)).toBe("1500m");
  });

  it("long distances quantize to nearest 250 m (3.0k and 3.2k stay distinct)", () => {
    expect(generateIntervalSignature([m(3000), m(3200)])).toBe("3000m-3250m");
  });

  it("times quantize to nearest 15 s", () => {
    expect(generateIntervalSignature([s(92), s(88)])).toBe("90s");
  });

  it("part order is deterministic (distances by metres, then times)", () => {
    expect(generateIntervalSignature([s(60), m(3000), m(400), s(30)])).toBe("400m-3000m-30s-60s");
  });
});

describe("generateStructureName", () => {
  it("single distinct part → (n)x form", () => {
    expect(generateStructureName([1000, 1000].map(m))).toBe("(n)x 1000m");
  });
  it("venue token names cleanly", () => {
    expect(generateStructureName([1509, 1518].map(m))).toBe("(n)x NG");
  });
  it("multiple parts → Mixed", () => {
    expect(generateStructureName([m(1000), m(4001.56)])).toBe("Mixed (1000m/4000m)");
  });
  it("nothing usable → Free Workout", () => {
    expect(generateStructureName([s(0)])).toBe("Free Workout");
  });
});

describe("mapSegmentsToComponents", () => {
  const seg = (
    type: string,
    targetType: string,
    targetValue: number,
  ): InsertIntervalSegment =>
    ({ type, targetType, targetValue }) as unknown as InsertIntervalSegment;

  it("keeps INTERVALS work segments and maps unit by targetType", () => {
    const comps = mapSegmentsToComponents([
      seg("INTERVALS", "distance", 1000),
      seg("INTERVALS", "time", 180),
    ]);
    expect(comps).toEqual([m(1000), s(180)]);
  });

  it("drops custom-target and zero-value segments (the 0s pollution)", () => {
    const comps = mapSegmentsToComponents([
      seg("INTERVALS", "time", 360),
      seg("INTERVALS", "custom", 0),
      seg("INTERVALS", "distance", 0),
      seg("ACTIVE_REST", "time", 90),
    ]);
    expect(comps).toEqual([s(360)]);
  });
});

describe("canonicalizeComponents", () => {
  it("returns venue/distance/time kinds", () => {
    const canon = canonicalizeComponents([m(1509), m(2000), s(90)]);
    expect(canon).toEqual([
      { kind: "venue", token: "NG", meters: 1504.2 },
      { kind: "distance", meters: 2000 },
      { kind: "time", seconds: 90 },
    ]);
  });
});
