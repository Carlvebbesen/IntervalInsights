import { describe, expect, it } from "bun:test";
import {
  buildSegmentsDeterministic,
  classifyLaps,
  deriveSpeed,
} from "../src/services/deterministic_segmenter";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { Lap } from "../src/types/strava/IDetailedActivity";

type Streams = Parameters<typeof buildSegmentsDeterministic>[3];

/** 1 Hz streams from a speed(t) profile; distance is the running integral. */
function streams(speedAt: (t: number) => number, dur: number, hrAt: (t: number) => number): Streams {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  let d = 0;
  for (let t = 0; t <= dur; t++) {
    time.push(t);
    distance.push(d);
    heartrate.push(hrAt(t));
    d += speedAt(t);
  }
  return {
    time: { data: time },
    distance: { data: distance },
    heartrate: { data: heartrate },
  } as unknown as Streams;
}

function lap(start_index: number, elapsed_time: number, average_speed: number, average_heartrate: number, distance = 0): Lap {
  return { start_index, elapsed_time, average_speed, average_heartrate, distance } as unknown as Lap;
}

const timeReps = (n: number, work: number, rest: number): ExpandedIntervalSet[] => [
  {
    steps: Array.from({ length: n }, () => ({
      work_type: "TIME" as const,
      work_value: work,
      recovery_type: "TIME" as const,
      recovery_value: rest,
      target_pace: null,
    })),
  },
];

describe("buildSegmentsDeterministic", () => {
  it("boundary mode: warmup/work/cooldown laps, sub-divides the work lap into reps", () => {
    // warmup 0-600 (slow), 6×(360 work @4 / 60 rest @0) = 600..3060, cooldown 3060-3260
    const speed = (t: number) => {
      if (t < 600) return 2.0;
      if (t < 3060) return (t - 600) % 420 < 360 ? 4.0 : 0.0;
      return 1.5;
    };
    const hr = (t: number) => (t < 600 ? 110 : t < 3060 ? 155 : 110);
    const s = streams(speed, 3260, hr);
    const laps = [
      lap(0, 600, 2.0, 110),
      lap(600, 2460, 3.4, 150),
      lap(3060, 200, 1.5, 110),
    ];
    const res = buildSegmentsDeterministic(1, laps, timeReps(6, 360, 60), s);
    expect(res).not.toBeNull();
    const segs = res!.segments;
    const intervals = segs.filter((x) => x.type === "INTERVALS");
    expect(intervals.length).toBe(6);
    expect(segs[0].type).toBe("WARMUP");
    // warmup ends near the 600s boundary, NOT crushed to ~0
    expect(segs[0].timeSeriesEndTime).toBeGreaterThan(540);
    expect(segs[0].timeSeriesEndTime).toBeLessThan(720);
    expect(segs.some((x) => x.type === "COOL_DOWN")).toBe(true);
    expect(res!.confidence).toBeGreaterThan(0.5);
  });

  it("per-rep mode: many laps → reps come straight from the high-speed work laps", () => {
    // warmup, then 8×(work fast / recovery slow), cooldown
    const laps: Lap[] = [lap(0, 600, 2.0, 120)];
    let idx = 600;
    for (let i = 0; i < 8; i++) {
      laps.push(lap(idx, 200, 4.5, 175)); // work
      idx += 200;
      laps.push(lap(idx, 60, 1.0, 165)); // recovery
      idx += 60;
    }
    laps.push(lap(idx, 300, 1.5, 130)); // cooldown
    const total = idx + 300;
    const speed = (t: number) => {
      for (const L of laps) {
        const st = L.start_index as number;
        if (t >= st && t < st + (L.elapsed_time as number)) return L.average_speed as number;
      }
      return 1.0;
    };
    const s = streams(speed, total, () => 160);
    const res = buildSegmentsDeterministic(1, laps, timeReps(8, 200, 60), s);
    expect(res).not.toBeNull();
    expect(res!.segments.filter((x) => x.type === "INTERVALS").length).toBe(8);
  });

  it("unusable mode: single lap (dense 20×45/15) → reps detected from speed", () => {
    // warmup 0-200, 20×(45 @4.5 / 15 @0) = 200..1400, cooldown 1400-1600
    const speed = (t: number) => {
      if (t < 200) return 2.0;
      if (t < 1400) return (t - 200) % 60 < 45 ? 4.5 : 0.0;
      return 1.5;
    };
    const s = streams(speed, 1600, () => 165);
    const laps = [lap(0, 1600, 3.0, 165)]; // one big lap
    const res = buildSegmentsDeterministic(1, laps, timeReps(20, 45, 15), s);
    expect(res).not.toBeNull();
    expect(res!.segments.filter((x) => x.type === "INTERVALS").length).toBe(20);
    // warmup is recovered near the true 200s boundary, not ~200s early (item 3)
    expect(res!.segments[0].type).toBe("WARMUP");
    expect(res!.segments[0].timeSeriesEndTime).toBeGreaterThan(140);
    expect(res!.segments[0].timeSeriesEndTime).toBeLessThan(260);
  });

  it("infers structure from speed when the user gave no title/structure (item 1)", () => {
    // no laps, no userSets: warmup 0-200, 10×(60 @4.5 / 30 @0), cooldown to 1200
    const speed = (t: number) => {
      if (t < 200) return 2.0;
      if (t < 1100) return (t - 200) % 90 < 60 ? 4.5 : 0.0;
      return 1.5;
    };
    const s = streams(speed, 1200, () => 165);
    const res = buildSegmentsDeterministic(1, [], [], s);
    expect(res).not.toBeNull();
    expect(res!.mode).toBe("inferred");
    expect(res!.segments.filter((x) => x.type === "INTERVALS").length).toBe(10);
    expect(res!.segments[0].type).toBe("WARMUP");
  });

  it("returns null when there is no structure AND no detectable reps", () => {
    const s = streams(() => 3.0, 600, () => 150); // steady — no surges to infer
    expect(buildSegmentsDeterministic(1, [], [], s)).toBeNull();
  });
});

describe("classifyLaps", () => {
  it("ignores junk trailing laps (≈0 m / a couple seconds)", () => {
    const laps = [
      lap(0, 600, 2.0, 110),
      lap(600, 1200, 3.4, 160),
      lap(1800, 200, 1.5, 110),
      lap(2000, 1, 0.0, 110, 0), // junk
    ];
    const time = Array.from({ length: 2001 }, (_, i) => i);
    const { mode } = classifyLaps(laps, time);
    expect(mode).toBe("boundary"); // 3 meaningful laps, not 4
  });

  it("one meaningful lap → unusable", () => {
    const time = Array.from({ length: 1001 }, (_, i) => i);
    expect(classifyLaps([lap(0, 1000, 3.0, 150)], time).mode).toBe("unusable");
  });

  it("per-rep: drops a trailing cooldown lap that slipped past the speed gate (the 5×NG case)", () => {
    // 5 NG reps (~1520 m @ ~3:50/km) + a 1900 m @ 4:50/km cooldown jog. The
    // cooldown sits at 0.78×max-speed — above the 0.75 gate — but is both slower
    // and longer than the reps, so it must not count as a 6th rep.
    const laps = [
      lap(0, 816, 2.9, 130, 2369), // warmup (slow → excluded by gate)
      lap(816, 353, 4.36, 170, 1538),
      lap(1169, 349, 4.39, 171, 1532),
      lap(1518, 352, 4.3, 169, 1513),
      lap(1870, 360, 4.23, 170, 1524),
      lap(2230, 356, 4.26, 172, 1518),
      lap(2586, 552, 3.44, 150, 1900), // trailing cooldown → dropped
    ];
    const time = Array.from({ length: 3139 }, (_, i) => i);
    const { mode, workLaps } = classifyLaps(laps, time);
    expect(mode).toBe("per-rep");
    expect(workLaps.length).toBe(5);
    expect(workLaps.every((l) => (l.distance ?? 0) < 1600)).toBe(true); // no 1900 m rep
  });

  it("per-rep: keeps a genuine final rep (faster finisher is not a cooldown)", () => {
    const laps = [
      lap(0, 600, 2.9, 130, 1800), // warmup
      lap(600, 230, 4.35, 170, 1000),
      lap(830, 232, 4.31, 171, 1000),
      lap(1062, 231, 4.33, 170, 1000),
      lap(1293, 233, 4.29, 170, 1000),
      lap(1526, 230, 4.35, 172, 1000),
      lap(1756, 228, 4.39, 174, 1000), // faster last rep → kept
    ];
    const time = Array.from({ length: 1985 }, (_, i) => i);
    expect(classifyLaps(laps, time).workLaps.length).toBe(6);
  });
});

describe("deriveSpeed", () => {
  it("recovers a steady pace from cumulative distance", () => {
    const time = Array.from({ length: 100 }, (_, i) => i);
    const distance = time.map((t) => t * 3.5); // 3.5 m/s
    const v = deriveSpeed(time, distance);
    expect(v[50]).toBeCloseTo(3.5, 1);
  });
});
