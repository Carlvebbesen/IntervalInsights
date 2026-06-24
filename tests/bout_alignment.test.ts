import { describe, expect, it } from "bun:test";
import { alignBoutsToReps, clampOverlongBouts } from "../src/services/deterministic_segmenter";

// Locks the contract of measure-aware bout binding: when noisy treadmill laps
// leave MORE work-candidate bouts than prescribed reps (a few rests crossed the
// speed gate), bind each rep to its best-matching bout by measure instead of by
// position — so a spurious bout no longer shifts every rep after it (activity 622,
// where a 175s effort got tagged the "60s" rep). The subsequence must preserve
// order, and TIME reps match on duration while DISTANCE reps match on covered
// distance.

type WT = "TIME" | "DISTANCE";
const rep = (workType: WT, workValue: number) => ({
  workType,
  workValue,
  recoveryType: "TIME" as WT,
  recoveryValue: 60,
  targetPace: null,
  setGroupIndex: 1,
  isLastInSet: false,
});
const bout = (start: number, end: number) => ({ start, end });
// TIME reps measure by duration, so the time/distance arrays are unused there.
const NO_STREAMS: number[] = [];

describe("alignBoutsToReps", () => {
  it("skips a spurious mid-sequence bout (the 622 fartlek bug)", () => {
    // Prescribed 180/120/60; detection produced an extra ~60s bout (a rest that
    // crossed the speed gate) right after the 180. Positional assignment would tag
    // the real 120 as "60" and drift; alignment must skip the spurious one.
    const bouts = [
      bout(0, 181), // 181s -> 180
      bout(190, 251), // 61s spurious rest
      bout(260, 379), // 119s -> 120
      bout(390, 450), // 60s -> 60
    ];
    const reps = [rep("TIME", 180), rep("TIME", 120), rep("TIME", 60)];
    const out = alignBoutsToReps(bouts, reps, NO_STREAMS, NO_STREAMS);
    expect(out).toEqual([bout(0, 181), bout(260, 379), bout(390, 450)]);
  });

  it("binds the full 5x(3,2,1) shape, skipping three interleaved rest bouts", () => {
    // 15 reps (180,120,60)x5; 18 bouts = the 15 efforts + 3 spurious ~60s rests.
    const efforts = [181, 117, 67, 177, 119, 60, 175, 117, 58, 174, 118, 62, 179, 118, 60];
    const reps = [180, 120, 60, 180, 120, 60, 180, 120, 60, 180, 120, 60, 180, 120, 60].map((v) =>
      rep("TIME", v),
    );
    // Lay efforts end to end with 60s rests, injecting 3 spurious 60s bouts after
    // efforts 3, 5 and 8 (the indices where 622's gate leaked).
    const bouts: { start: number; end: number }[] = [];
    let t = 0;
    efforts.forEach((d, i) => {
      bouts.push(bout(t, t + d));
      t += d + 30;
      if (i === 3 || i === 5 || i === 8) {
        bouts.push(bout(t, t + 60)); // spurious rest-bout
        t += 60 + 30;
      }
    });
    expect(bouts.length).toBe(18);
    const out = alignBoutsToReps(bouts, reps, NO_STREAMS, NO_STREAMS);
    expect(out.length).toBe(15);
    // every bound bout's duration is within 25% of its prescribed target
    out.forEach((b, i) => {
      const ratio = (b.end - b.start) / reps[i].workValue;
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.4);
    });
  });

  it("returns bouts unchanged when counts already match (no DP)", () => {
    const bouts = [bout(0, 180), bout(240, 360), bout(420, 480)];
    const reps = [rep("TIME", 180), rep("TIME", 120), rep("TIME", 60)];
    expect(alignBoutsToReps(bouts, reps, NO_STREAMS, NO_STREAMS)).toEqual(bouts);
  });

  it("falls back to the leading N bouts when there are fewer bouts than reps", () => {
    const bouts = [bout(0, 180), bout(240, 360)];
    const reps = [rep("TIME", 180), rep("TIME", 120), rep("TIME", 60)];
    expect(alignBoutsToReps(bouts, reps, NO_STREAMS, NO_STREAMS)).toEqual(bouts);
  });

  it("preserves chronological order of the chosen subsequence", () => {
    const bouts = [bout(0, 60), bout(100, 280), bout(320, 440), bout(500, 560)];
    const reps = [rep("TIME", 180), rep("TIME", 120), rep("TIME", 60)];
    const out = alignBoutsToReps(bouts, reps, NO_STREAMS, NO_STREAMS);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThan(out[i - 1].start);
  });

  it("matches DISTANCE reps by covered distance, not duration (alignBoutsToReps)", () => {
    // 1Hz streams: 1000m effort, then a 200m spurious bout, then another 1000m.
    const time = Array.from({ length: 301 }, (_, i) => i);
    const distance = new Array<number>(301);
    for (let i = 0; i <= 300; i++) {
      if (i <= 100) distance[i] = 10 * i; // 0..1000m
      else if (i <= 110) distance[i] = 1000; // rest
      else if (i <= 160) distance[i] = 1000 + 4 * (i - 110); // ..1200m (spurious 200m)
      else if (i <= 200) distance[i] = 1200; // rest
      else distance[i] = 1200 + 10 * (i - 200); // ..2200m
    }
    const bouts = [bout(0, 100), bout(110, 160), bout(200, 300)];
    const reps = [rep("DISTANCE", 1000), rep("DISTANCE", 1000)];
    const out = alignBoutsToReps(bouts, reps, time, distance);
    expect(out).toEqual([bout(0, 100), bout(200, 300)]);
  });
});

describe("clampOverlongBouts", () => {
  it("trims a TIME bout that overruns the target beyond tolerance", () => {
    // 90s detected for a 60s rep (1.5x) -> pulled back to exactly 60s.
    const out = clampOverlongBouts([bout(0, 90)], [rep("TIME", 60)], NO_STREAMS, NO_STREAMS);
    expect(out[0]).toEqual(bout(0, 60));
  });

  it("keeps a TIME bout within tolerance (real variation)", () => {
    // 66s for a 60s rep (1.1x < 1.15) -> unchanged.
    const out = clampOverlongBouts([bout(0, 66)], [rep("TIME", 60)], NO_STREAMS, NO_STREAMS);
    expect(out[0]).toEqual(bout(0, 66));
  });

  it("never extends an under-measured bout (that's expandShortReps' job)", () => {
    const out = clampOverlongBouts([bout(0, 40)], [rep("TIME", 60)], NO_STREAMS, NO_STREAMS);
    expect(out[0]).toEqual(bout(0, 40));
  });

  it("trims a DISTANCE bout to the prescribed-distance point", () => {
    // 1Hz, 10 m/s: a bout covering 1200 m for a 1000 m rep -> end pulled to the
    // 1000 m mark (t=100), not left at 1200 m (t=120).
    const time = Array.from({ length: 121 }, (_, i) => i);
    const distance = time.map((i) => 10 * i);
    const out = clampOverlongBouts([bout(0, 120)], [rep("DISTANCE", 1000)], time, distance);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(100);
  });

  it("keeps a DISTANCE bout within tolerance", () => {
    const time = Array.from({ length: 121 }, (_, i) => i);
    const distance = time.map((i) => 10 * i); // 1050 m bout = 1.05x
    const out = clampOverlongBouts([bout(0, 105)], [rep("DISTANCE", 1000)], time, distance);
    expect(out[0]).toEqual(bout(0, 105));
  });
});
