import { describe, expect, test } from "bun:test";
import { defaultPenalty, noiseVariance, pelt, variance, viterbiTwoState } from "../src/services/changepoint";

describe("pelt change-point detection", () => {
  test("finds the boundary of a clean two-level step", () => {
    const signal = [...Array(30).fill(1), ...Array(30).fill(5)];
    const cps = pelt(signal, 5, defaultPenalty(signal));
    expect(cps.length).toBe(1);
    expect(Math.abs(cps[0] - 30)).toBeLessThanOrEqual(2);
  });

  test("recovers repeated work/rest blocks (≈20×45/15 shape)", () => {
    const signal: number[] = [];
    for (let r = 0; r < 20; r++) {
      for (let i = 0; i < 9; i++) signal.push(4.5); // ~45s work
      for (let i = 0; i < 3; i++) signal.push(1.5); // ~15s rest
    }
    const cps = pelt(signal, 2, defaultPenalty(signal));
    // 20 work + 20 rest blocks → ~39 interior boundaries; allow detector slack.
    expect(cps.length).toBeGreaterThanOrEqual(30);
  });

  test("does NOT over-segment a high-contrast signal (robust noise penalty)", () => {
    // Total variance is large, but within-segment noise is ~0: must stay at 1 boundary.
    const signal = [...Array(40).fill(0.2), ...Array(40).fill(6)];
    const cps = pelt(signal, 5, defaultPenalty(signal));
    expect(cps.length).toBe(1);
  });

  test("returns no change points for a flat signal", () => {
    const signal = Array(50).fill(3);
    expect(pelt(signal, 5, defaultPenalty(signal))).toEqual([]);
  });

  test("respects minSize (no segment shorter than the guard)", () => {
    const signal = [1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5];
    const cps = pelt(signal, 6, defaultPenalty(signal));
    const bounds = [0, ...cps, signal.length];
    for (let i = 1; i < bounds.length; i++) expect(bounds[i] - bounds[i - 1]).toBeGreaterThanOrEqual(6);
  });
});

describe("noiseVariance", () => {
  test("ignores the jump at a change-point (robust to step)", () => {
    const signal = [...Array(50).fill(1), ...Array(50).fill(9)];
    // One large jump among 99 tiny diffs → median squared-diff ≈ 0.
    expect(noiseVariance(signal)).toBeLessThan(0.01);
  });

  test("tracks within-segment noise", () => {
    const noisy = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    expect(noiseVariance(noisy)).toBeGreaterThan(0);
  });

  test("total variance >> noise variance for a clean step", () => {
    const signal = [...Array(50).fill(0), ...Array(50).fill(10)];
    expect(variance(signal)).toBeGreaterThan(noiseVariance(signal) * 100);
  });
});

describe("viterbiTwoState markov smoothing", () => {
  test("suppresses single-sample flicker when the switch cost dominates", () => {
    // Mostly work (5) with two stray rest (1) blips. Keeping a blip as work costs
    // (1−5)²=16; cutting+rejoining costs 2·switchPenalty. With penalty 20 (>16) the
    // prior wins and the blips stay work — the flicker is smoothed away.
    const signal = [5, 5, 5, 1, 5, 5, 5, 5, 1, 5, 5, 5];
    const labels = viterbiTwoState(signal, 1, 5, 20);
    expect(labels.every((l) => l === 1)).toBe(true);
  });

  test("still tracks a genuine sustained transition", () => {
    const signal = [...Array(10).fill(1), ...Array(10).fill(5)];
    const labels = viterbiTwoState(signal, 1, 5, 2);
    expect(labels[0]).toBe(0);
    expect(labels[labels.length - 1]).toBe(1);
  });

  test("a higher switch penalty merges more aggressively", () => {
    const signal = [5, 1, 5, 1, 5, 1, 5, 1];
    const sticky = viterbiTwoState(signal, 1, 5, 100);
    const switches = sticky.reduce((a, l, i) => a + (i > 0 && l !== sticky[i - 1] ? 1 : 0), 0);
    expect(switches).toBe(0);
  });
});
