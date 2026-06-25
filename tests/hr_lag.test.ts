import { describe, expect, test } from "bun:test";
import { estimateHrLag, shiftHrEarlier } from "../src/services/hr_lag";

/** 1 Hz time axis of length n. */
const axis = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("estimateHrLag", () => {
  test("recovers a known lag where HR trails speed", () => {
    const n = 120;
    const time = axis(n);
    // Square-wave speed; HR is the same wave delayed by 10 samples.
    const lag = 10;
    const speed = time.map((t) => (Math.floor(t / 20) % 2 === 0 ? 5 : 1));
    const hr = time.map((t) => {
      const src = t - lag;
      return src >= 0 && Math.floor(src / 20) % 2 === 0 ? 170 : 130;
    });
    const est = estimateHrLag(time, speed, hr, 30);
    expect(Math.abs(est - lag)).toBeLessThanOrEqual(2);
  });

  test("returns 0 when HR is flat (no structure to align)", () => {
    const time = axis(60);
    const speed = time.map((t) => (Math.floor(t / 10) % 2 === 0 ? 5 : 1));
    const hr = Array(60).fill(150);
    expect(estimateHrLag(time, speed, hr, 30)).toBe(0);
  });
});

describe("shiftHrEarlier", () => {
  test("pulls HR samples back by the lag", () => {
    const time = axis(10);
    const hr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const shifted = shiftHrEarlier(time, hr, 3);
    expect(shifted[0]).toBe(3);
    expect(shifted[9]).toBe(9); // tail clamps to last value
  });

  test("no-op for zero/negative lag", () => {
    const time = axis(5);
    const hr = [1, 2, 3, 4, 5];
    expect(shiftHrEarlier(time, hr, 0)).toEqual(hr);
  });
});
