import { describe, expect, it } from "bun:test";
import { buildSegmentsDeterministic } from "../src/services/deterministic_segmenter";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { Lap } from "../src/types/strava/IDetailedActivity";
import type { StreamSet } from "../src/types/strava/IStream";

// Locks the count-guarantee: when per-rep lap detection finds FEWER work blocks
// than the known structure (treadmill HR-only / speed-ambiguous reps — 626/616),
// the segmenter lays the full prescribed structure so the INTERVALS count matches
// the title, and returns a confidence above the LLM-fallback threshold so the
// result is actually used (not handed to the count-inventing LLM).

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

/** Build a 1 Hz activity from [durationSec, speedMps] phases laid end to end. */
function synth(phases: [number, number][]): { streams: StatsStreams; laps: Lap[] } {
  const time: number[] = [];
  const distance: number[] = [];
  let t = 0;
  let d = 0;
  const laps: Lap[] = [];
  for (const [dur, spd] of phases) {
    const startIndex = time.length;
    for (let i = 0; i < dur; i++) {
      time.push(t);
      distance.push(d);
      t += 1;
      d += spd;
    }
    laps.push({
      start_index: startIndex,
      elapsed_time: dur,
      distance: dur * spd,
      average_speed: spd,
    } as unknown as Lap);
  }
  time.push(t);
  distance.push(d);
  return {
    streams: { time: { data: time }, distance: { data: distance } } as StatsStreams,
    laps,
  };
}

const timeReps = (n: number, work: number, rest: number): ExpandedIntervalSet[] =>
  [
    {
      set_recovery: 0,
      steps: Array.from({ length: n }, () => ({
        work_type: "TIME",
        work_value: work,
        recovery_type: "TIME",
        recovery_value: rest,
        target_pace: null,
      })),
    },
  ] as unknown as ExpandedIntervalSet[];

describe("buildSegmentsDeterministic — count guarantee (under-detection)", () => {
  it("lays the full structure when work-laps < reps, matching the title count", () => {
    // 4×60s/60s treadmill: 2 reps run fast (detected as work), 2 run only
    // slightly above rest (HR-only — below the 0.75×max speed gate, so missed).
    // Lots of laps => per-rep mode; only 2 clear the work gate => under-detection.
    const { streams, laps } = synth([
      [200, 2.0], // warmup
      [60, 5.0], // work 1 (fast → detected)
      [60, 2.0], // rest
      [60, 5.0], // work 2 (fast → detected)
      [60, 2.0], // rest
      [60, 3.4], // work 3 (medium → below 0.75×5 gate, missed)
      [60, 2.0], // rest
      [60, 3.4], // work 4 (medium → missed)
      [150, 2.0], // cooldown
    ]);
    const res = buildSegmentsDeterministic(1, laps, timeReps(4, 60, 60), streams);
    expect(res).not.toBeNull();
    const intervals = res!.segments.filter((s) => s.type === "INTERVALS");
    expect(intervals.length).toBe(4); // count matches the title, not the 2 detected
    expect(res!.mode).toBe("per-rep");
    expect(res!.confidence).toBeGreaterThanOrEqual(0.5); // used, not dropped to the LLM
  });

  it("leaves a cleanly-detected workout at its real count (no forcing)", () => {
    // All 4 reps fast → all detected; count guarantee must NOT engage.
    const { streams, laps } = synth([
      [200, 2.0],
      [60, 5.0],
      [60, 2.0],
      [60, 5.0],
      [60, 2.0],
      [60, 5.0],
      [60, 2.0],
      [60, 5.0],
      [150, 2.0],
    ]);
    const res = buildSegmentsDeterministic(2, laps, timeReps(4, 60, 60), streams);
    expect(res).not.toBeNull();
    expect(res!.segments.filter((s) => s.type === "INTERVALS").length).toBe(4);
  });
});
