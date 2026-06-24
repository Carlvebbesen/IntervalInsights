import { describe, expect, it } from "bun:test";
import { expandShortReps } from "../src/services/deterministic_segmenter";

// Locks the contract of the short-rep pace-lag recovery: known short TIME reps
// (<=90s) whose detected bout is the late high-speed core are expanded to the
// prescribed duration SYMMETRICALLY (backward-biased) — never forward-only (which
// overshoots into the rest and inverts work/rest), never shrinking the core, and
// clamped to the neighbouring bouts.

type WT = "TIME" | "DISTANCE";
const rep = (workType: WT, workValue: number) => ({
  workType,
  workValue,
  recoveryType: "TIME" as WT,
  recoveryValue: 15,
  targetPace: null,
  setGroupIndex: 1,
  isLastInSet: false,
});
const bout = (start: number, end: number) => ({ start, end });

describe("expandShortReps", () => {
  it("expands a short TIME rep symmetrically around the late core (no forward-only overshoot)", () => {
    // core [15,40] = 25s, sitting late in a true 45s rep; neighbours far away.
    const out = expandShortReps([bout(15, 40)], [rep("TIME", 45)], 0, 120);
    expect(out[0].end - out[0].start).toBeCloseTo(45, 5); // recovered to prescribed
    expect(out[0].start).toBeLessThan(15); // expanded BACKWARD, not forward-only
    expect(out[0].end).toBeLessThan(40 + 45); // did NOT shoot forward by a full rep
  });

  it("leaves long TIME reps (>90s) untouched", () => {
    const out = expandShortReps([bout(0, 100)], [rep("TIME", 360)], 0, 1000);
    expect(out[0]).toEqual(bout(0, 100));
  });

  it("leaves DISTANCE reps untouched", () => {
    const out = expandShortReps([bout(0, 30)], [rep("DISTANCE", 1000)], 0, 1000);
    expect(out[0]).toEqual(bout(0, 30));
  });

  it("does not shrink a core already >= the prescribed duration", () => {
    const out = expandShortReps([bout(0, 50)], [rep("TIME", 45)], 0, 1000);
    expect(out[0]).toEqual(bout(0, 50));
  });

  it("clamps to neighbouring bouts so reps never overlap", () => {
    const out = expandShortReps(
      [bout(50, 75), bout(110, 135)],
      [rep("TIME", 45), rep("TIME", 45)],
      0,
      200,
    );
    expect(out[0].end).toBeLessThanOrEqual(out[1].start);
    expect(out[1].start).toBeGreaterThanOrEqual(out[0].end);
    expect(out[0].end - out[0].start).toBeGreaterThan(25); // still recovered some length
  });

  it("never starts before t0", () => {
    const out = expandShortReps([bout(15, 35)], [rep("TIME", 90)], 12, 1000);
    expect(out[0].start).toBeGreaterThanOrEqual(12);
  });
});
