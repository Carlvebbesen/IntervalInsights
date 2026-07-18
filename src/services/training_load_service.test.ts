import { describe, expect, test } from "bun:test";
import {
  computeActivityLoad,
  gradeFactor,
  hrss,
  type LoadStreams,
  paceLoad,
  powerTss,
} from "./training_load_service";

/** n samples at `dt`-second spacing, time 0..(n-1)*dt. */
function timeAxis(n: number, dt = 1): number[] {
  return Array.from({ length: n }, (_, i) => i * dt);
}

function constant(value: number, n: number): number[] {
  return new Array(n).fill(value);
}

describe("paceLoad — David Tinker running-pace load", () => {
  const THRESHOLD = 3.5;

  test("1 hour at threshold on the flat === exactly 100", () => {
    const n = 3601;
    const streams: LoadStreams = { time: timeAxis(n), velocity: constant(THRESHOLD, n) };
    expect(paceLoad(streams, THRESHOLD)).toBeCloseTo(100, 5);
  });

  test("constant supra-threshold pace reduces to (v/threshold)² × moving_hours × 100", () => {
    // 30 min @ 4.2 m/s, threshold 3.5 → 1.2² × 0.5 × 100 = 72
    const n = 1801;
    const streams: LoadStreams = { time: timeAxis(n), velocity: constant(4.2, n) };
    expect(paceLoad(streams, THRESHOLD)).toBeCloseTo(72, 4);
  });

  test("stopped samples contribute 0 (moving-time only)", () => {
    // 30 min moving @ threshold + 30 min stopped → 0.5 h at intensity 1 → 50
    const half = 1800;
    const n = 2 * half + 1;
    const velocity = [...constant(THRESHOLD, half + 1), ...constant(0, half)];
    const streams: LoadStreams = { time: timeAxis(n), velocity };
    expect(paceLoad(streams, THRESHOLD)).toBeCloseTo(50, 3);
  });

  test("explicit moving=false stops accumulation regardless of velocity", () => {
    const n = 1801;
    const moving = Array.from({ length: n }, (_, i) => i <= 900);
    const streams: LoadStreams = {
      time: timeAxis(n),
      velocity: constant(THRESHOLD, n),
      moving,
    };
    // 15 min moving @ intensity 1 → 0.25 h × 100 = 25
    expect(paceLoad(streams, THRESHOLD)).toBeCloseTo(25, 3);
  });

  test("dt is capped at 30 s so recording gaps don't inflate load", () => {
    // Two samples 1000 s apart → dt capped to 30 → 30/3600 × 100 ≈ 0.8333
    const streams: LoadStreams = { time: [0, 1000], velocity: [THRESHOLD, THRESHOLD] };
    expect(paceLoad(streams, THRESHOLD)).toBeCloseTo(0.8333, 3);
  });

  test("zero/invalid threshold → 0", () => {
    const streams: LoadStreams = { time: timeAxis(10), velocity: constant(3.5, 10) };
    expect(paceLoad(streams, 0)).toBe(0);
  });
});

describe("gradeFactor — Minetti (2002) cost curve, normalised to flat", () => {
  test("factor(0) is exactly 1", () => {
    expect(gradeFactor(0)).toBe(1);
  });

  test("+10% grade matches the hand-evaluated Minetti polynomial", () => {
    // C(0.1)/C(0) = 5.968214 / 3.6
    expect(gradeFactor(0.1)).toBeCloseTo(1.657837, 5);
  });

  test("-10% grade matches the hand-evaluated Minetti polynomial", () => {
    // C(-0.1)/C(0) = 2.151706 / 3.6
    expect(gradeFactor(-0.1)).toBeCloseTo(0.597696, 5);
  });

  test("monotone increasing uphill", () => {
    expect(gradeFactor(0.05)).toBeLessThan(gradeFactor(0.1));
    expect(gradeFactor(0.1)).toBeLessThan(gradeFactor(0.2));
    expect(gradeFactor(0.2)).toBeLessThan(gradeFactor(0.3));
  });

  test("mild downhill is cheaper than flat (< 1)", () => {
    expect(gradeFactor(-0.05)).toBeLessThan(1);
    expect(gradeFactor(-0.1)).toBeLessThan(1);
  });

  test("grade is clamped to ±0.30", () => {
    expect(gradeFactor(0.5)).toBe(gradeFactor(0.3));
    expect(gradeFactor(-0.9)).toBe(gradeFactor(-0.3));
  });
});

describe("paceLoad GAP integration", () => {
  const THRESHOLD = 3.5;

  test("a constant +10% grade scales load by factor(0.1)² vs raw speed", () => {
    // v = 3.0 m/s, distance = 3·i, altitude = 0.1·distance → grade 0.1 everywhere
    const n = 3601;
    const time = timeAxis(n);
    const velocity = constant(3.0, n);
    const distance = time.map((t) => 3.0 * t);
    const altitude = distance.map((d) => 0.1 * d);
    const gapLoad = paceLoad({ time, velocity, distance, altitude }, THRESHOLD, true);
    const rawLoad = paceLoad({ time, velocity, distance, altitude }, THRESHOLD, false);
    const expectedFactor = gradeFactor(0.1) ** 2;
    expect(gapLoad / rawLoad).toBeCloseTo(expectedFactor, 3);
  });

  test("mild downhill yields less load than raw speed", () => {
    const n = 1801;
    const time = timeAxis(n);
    const velocity = constant(3.0, n);
    const distance = time.map((t) => 3.0 * t);
    const altitude = distance.map((d) => -0.1 * d);
    const gapLoad = paceLoad({ time, velocity, distance, altitude }, THRESHOLD, true);
    const rawLoad = paceLoad({ time, velocity, distance, altitude }, THRESHOLD, false);
    expect(gapLoad).toBeLessThan(rawLoad);
  });
});

describe("hrss — normalised exponential TRIMP", () => {
  const rest = 50;
  const max = 190;
  const lthr = 160;

  test("1 hour held at LTHR === exactly 100", () => {
    const n = 3601;
    const streams: LoadStreams = { time: timeAxis(n), heartrate: constant(lthr, n) };
    expect(hrss(streams, { lthr, restingHr: rest, maxHr: max, sex: "male" })).toBeCloseTo(100, 5);
  });

  test("sub-threshold HR matches the closed-form TRIMP ratio (male F=1.92)", () => {
    const hr = 140;
    const minutes = 30;
    const n = minutes * 60 + 1;
    const streams: LoadStreams = { time: timeAxis(n), heartrate: constant(hr, n) };
    const f = 1.92;
    const hrr = (hr - rest) / (max - rest);
    const hrrL = (lthr - rest) / (max - rest);
    const expected =
      (100 * (minutes * hrr * 0.64 * Math.exp(f * hrr))) / (60 * hrrL * 0.64 * Math.exp(f * hrrL));
    expect(hrss(streams, { lthr, restingHr: rest, maxHr: max, sex: "male" })).toBeCloseTo(
      expected,
      4,
    );
  });

  test("female exponent (1.67) differs from male and defaults to male when sex null", () => {
    const hr = 140;
    const n = 601;
    const streams: LoadStreams = { time: timeAxis(n), heartrate: constant(hr, n) };
    const maleDefault = hrss(streams, { lthr, restingHr: rest, maxHr: max, sex: null });
    const male = hrss(streams, { lthr, restingHr: rest, maxHr: max, sex: "male" });
    const female = hrss(streams, { lthr, restingHr: rest, maxHr: max, sex: "female" });
    expect(maleDefault).toBeCloseTo(male, 6);
    expect(female).not.toBeCloseTo(male, 2);
  });

  test("missing inputs → 0", () => {
    const streams: LoadStreams = { time: timeAxis(10), heartrate: constant(150, 10) };
    expect(hrss(streams, { lthr: null, restingHr: rest, maxHr: max })).toBe(0);
    expect(hrss(streams, { lthr, restingHr: null, maxHr: max })).toBe(0);
    expect(hrss(streams, { lthr, restingHr: rest, maxHr: null })).toBe(0);
  });
});

describe("powerTss — Coggan TSS", () => {
  const ftp = 250;

  test("1 hour at FTP === exactly 100", () => {
    const n = 3601;
    const streams: LoadStreams = { time: timeAxis(n), watts: constant(ftp, n) };
    expect(powerTss(streams, ftp)).toBeCloseTo(100, 5);
  });

  test("supra-FTP constant power reduces to IF² × moving_hours × 100", () => {
    // 30 min @ 300 W, FTP 250 → 1.2² × 0.5 × 100 = 72
    const n = 1801;
    const streams: LoadStreams = { time: timeAxis(n), watts: constant(300, n) };
    expect(powerTss(streams, ftp)).toBeCloseTo(72, 3);
  });

  test("two-level square wave NP matches the hand-computed 4th-power mean (≤0.5%)", () => {
    // 1 h @ 100 W then 1 h @ 300 W. Ideal NP = (½·100⁴ + ½·300⁴)^¼; the only
    // deviation is the 30 s rolling-window smear across the single step.
    const half = 3600;
    const n = 2 * half + 1;
    const watts = [...constant(100, half + 1), ...constant(300, half)];
    const streams: LoadStreams = { time: timeAxis(n), watts };
    const idealNp = (0.5 * 100 ** 4 + 0.5 * 300 ** 4) ** 0.25;
    const movingHours = (n - 1) / 3600;
    const expectedTss = (idealNp / ftp) ** 2 * movingHours * 100;
    const tss = powerTss(streams, ftp);
    expect(Math.abs(tss - expectedTss) / expectedTss).toBeLessThan(0.005);
  });

  test("zero/invalid ftp → 0", () => {
    const streams: LoadStreams = { time: timeAxis(10), watts: constant(200, 10) };
    expect(powerTss(streams, 0)).toBe(0);
  });
});

describe("computeActivityLoad — source-priority picker", () => {
  const thresholds = {
    thresholdPaceMps: 3.5,
    lthr: 160,
    restingHr: 50,
    maxHr: 190,
    ftp: 250,
    sex: "male" as const,
  };

  function run(n: number) {
    return timeAxis(n);
  }

  test("power wins when watts + ftp present, and reports IF intensity", () => {
    const n = 3601;
    const res = computeActivityLoad({
      sportType: "Ride",
      streams: {
        time: run(n),
        watts: constant(250, n),
        heartrate: constant(160, n),
        velocity: constant(3.5, n),
      },
      thresholds,
    });
    expect(res?.source).toBe("power");
    expect(res?.load).toBeCloseTo(100, 1);
    expect(res?.intensity).toBeCloseTo(1, 3);
  });

  test("running with no watts falls to pace; no altitude → raw speed", () => {
    const n = 3601;
    const res = computeActivityLoad({
      sportType: "Run",
      streams: { time: run(n), velocity: constant(3.5, n), heartrate: constant(160, n) },
      thresholds,
    });
    expect(res?.source).toBe("pace");
    expect(res?.load).toBeCloseTo(100, 1);
  });

  test("running with altitude uses GAP (uphill load exceeds raw)", () => {
    const n = 3601;
    const time = run(n);
    const velocity = constant(3.0, n);
    const distance = time.map((t) => 3.0 * t);
    const altitude = distance.map((d) => 0.1 * d);
    const gap = computeActivityLoad({
      sportType: "Run",
      streams: { time, velocity, distance, altitude },
      thresholds,
    });
    const flat = computeActivityLoad({
      sportType: "Run",
      streams: { time, velocity, distance },
      thresholds,
    });
    expect(gap?.source).toBe("pace");
    expect(gap?.load ?? 0).toBeGreaterThan(flat?.load ?? 0);
  });

  test("no velocity/watts falls to HRSS", () => {
    const n = 3601;
    const res = computeActivityLoad({
      sportType: "Run",
      streams: { time: run(n), heartrate: constant(160, n) },
      thresholds,
    });
    expect(res?.source).toBe("hr");
    expect(res?.load).toBeCloseTo(100, 1);
  });

  test("pace is skipped for non-running sports even with velocity + threshold", () => {
    const n = 3601;
    const res = computeActivityLoad({
      sportType: "Ride",
      streams: { time: run(n), velocity: constant(3.5, n), heartrate: constant(160, n) },
      thresholds,
    });
    // no watts → pace skipped (not running) → falls to HR
    expect(res?.source).toBe("hr");
  });

  test("no usable stream or missing thresholds → null", () => {
    expect(
      computeActivityLoad({
        sportType: "Run",
        streams: { time: run(10) },
        thresholds,
      }),
    ).toBeNull();

    expect(
      computeActivityLoad({
        sportType: "Run",
        streams: { time: run(10), velocity: constant(3.5, 10) },
        thresholds: { ...thresholds, thresholdPaceMps: null, lthr: null },
      }),
    ).toBeNull();
  });
});
