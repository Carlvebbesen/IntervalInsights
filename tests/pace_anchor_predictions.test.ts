import { describe, expect, test } from "bun:test";
import {
  computeVdot,
  deriveAnchor,
  type MaximalEffort,
  predictRaceTimeSecFromVdot,
  RACE_DISTANCES_M,
} from "../src/services/pace_anchor_service";

const FIVE_K = 5000;
const TEN_K = 10000;
const HALF = 21097.5;
const MARATHON = 42195;

function toSec(clock: string): number {
  return clock.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

function predict(vdot: number, distanceM: number): number {
  const t = predictRaceTimeSecFromVdot(vdot, distanceM);
  if (t == null) throw new Error(`no prediction for vdot ${vdot} / ${distanceM}m`);
  return t;
}

function vdotForRaceTime(distanceM: number, targetSec: number): number {
  let lo = 20;
  let hi = 90;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (predict(mid, distanceM) > targetSec) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const DANIELS_REFERENCE: {
  vdot: number;
  fiveK: string;
  tenK: string;
  half: string;
  marathon: string;
}[] = [
  { vdot: 30, fiveK: "30:41", tenK: "1:03:49", half: "2:21:17", marathon: "4:49:49" },
  { vdot: 40, fiveK: "24:06", tenK: "50:01", half: "1:50:54", marathon: "3:49:37" },
  { vdot: 50, fiveK: "19:56", tenK: "41:20", half: "1:31:31", marathon: "3:10:40" },
  { vdot: 60, fiveK: "17:03", tenK: "35:22", half: "1:18:09", marathon: "2:43:22" },
  { vdot: 70, fiveK: "14:56", tenK: "31:01", half: "1:08:23", marathon: "2:23:13" },
];

describe("matches the Daniels VDOT reference table (validated vs Daniels' published tables)", () => {
  for (const row of DANIELS_REFERENCE) {
    const cases: [string, number, string][] = [
      ["5K", FIVE_K, row.fiveK],
      ["10K", TEN_K, row.tenK],
      ["half", HALF, row.half],
      ["marathon", MARATHON, row.marathon],
    ];
    for (const [label, distanceM, expected] of cases) {
      test(`VDOT ${row.vdot} ${label} ≈ ${expected}`, () => {
        const diff = Math.abs(predict(row.vdot, distanceM) - toSec(expected));
        expect(diff).toBeLessThanOrEqual(2);
      });
    }
  }
});

describe("predictions invert back to the same VDOT across the full range", () => {
  for (let vdot = 30; vdot <= 72; vdot += 1) {
    test(`VDOT ${vdot} round-trips at every distance`, () => {
      for (const distanceM of RACE_DISTANCES_M) {
        const sec = predict(vdot, distanceM);
        const back = computeVdot(distanceM / sec, sec);
        expect(back).not.toBeNull();
        expect(Math.abs((back as number) - vdot)).toBeLessThan(0.15);
      }
    });
  }
});

describe("predictions are physiologically ordered", () => {
  for (const vdot of [32, 40, 48, 56, 64, 70]) {
    test(`VDOT ${vdot}: longer distance ⇒ longer time and slower pace`, () => {
      const times = RACE_DISTANCES_M.map((d) => predict(vdot, d));
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1]!);
        const pacePrev = (times[i - 1]! / RACE_DISTANCES_M[i - 1]!) * 1000;
        const paceNow = (times[i]! / RACE_DISTANCES_M[i]!) * 1000;
        expect(paceNow).toBeGreaterThan(pacePrev);
      }
    });
  }

  test("higher VDOT is strictly faster at every distance", () => {
    for (const distanceM of RACE_DISTANCES_M) {
      let prev = Infinity;
      for (let vdot = 30; vdot <= 72; vdot += 1) {
        const sec = predict(vdot, distanceM);
        expect(sec).toBeLessThan(prev);
        prev = sec;
      }
    }
  });
});

describe("covers the requested marathon range (2:30:00 → 5:00:00)", () => {
  const targets = ["2:30:00", "2:45:00", "3:00:00", "3:30:00", "4:00:00", "4:30:00", "5:00:00"];
  for (const clock of targets) {
    test(`marathon ${clock} resolves to a sane, self-consistent VDOT`, () => {
      const target = toSec(clock);
      const vdot = vdotForRaceTime(MARATHON, target);
      expect(vdot).toBeGreaterThan(20);
      expect(vdot).toBeLessThan(90);
      expect(Math.abs(predict(vdot, MARATHON) - target)).toBeLessThanOrEqual(2);
      expect(predict(vdot, FIVE_K)).toBeLessThan(predict(vdot, TEN_K));
      expect(predict(vdot, HALF)).toBeLessThan(target);
    });
  }
});

describe("covers the requested 10K range (30:00 → 60:00)", () => {
  const targets = ["30:00", "35:00", "40:00", "45:00", "50:00", "55:00", "60:00"];
  for (const clock of targets) {
    test(`10K ${clock} resolves to a sane, self-consistent VDOT`, () => {
      const target = toSec(clock);
      const vdot = vdotForRaceTime(TEN_K, target);
      expect(vdot).toBeGreaterThan(20);
      expect(vdot).toBeLessThan(90);
      expect(Math.abs(predict(vdot, TEN_K) - target)).toBeLessThanOrEqual(2);
      expect(predict(vdot, FIVE_K)).toBeLessThan(target);
      expect(predict(vdot, MARATHON)).toBeGreaterThan(predict(vdot, HALF));
    });
  }
});

describe("covers the requested half-marathon range (1:10:00 → 2:00:00)", () => {
  const targets = ["1:10:00", "1:20:00", "1:30:00", "1:40:00", "1:50:00", "2:00:00"];
  for (const clock of targets) {
    test(`half ${clock} resolves to a sane, self-consistent VDOT`, () => {
      const target = toSec(clock);
      const vdot = vdotForRaceTime(HALF, target);
      expect(vdot).toBeGreaterThan(20);
      expect(vdot).toBeLessThan(90);
      expect(Math.abs(predict(vdot, HALF) - target)).toBeLessThanOrEqual(2);
      expect(predict(vdot, TEN_K)).toBeLessThan(target);
      expect(predict(vdot, MARATHON)).toBeGreaterThan(target);
    });
  }
});

describe("equivalent race times agree with the reference table within a few seconds", () => {
  for (const row of DANIELS_REFERENCE) {
    test(`a runner who races 10K in ${row.tenK} is predicted half ${row.half} / marathon ${row.marathon}`, () => {
      const vdot = vdotForRaceTime(TEN_K, toSec(row.tenK));
      expect(Math.abs(predict(vdot, HALF) - toSec(row.half))).toBeLessThanOrEqual(6);
      expect(Math.abs(predict(vdot, MARATHON) - toSec(row.marathon))).toBeLessThanOrEqual(6);
      expect(Math.abs(predict(vdot, FIVE_K) - toSec(row.fiveK))).toBeLessThanOrEqual(6);
    });
  }
});

describe("deriveAnchor end-to-end from interval efforts", () => {
  test("1000m + 3000m reps produce a critical-speed anchor with four ordered race predictions", () => {
    const efforts: MaximalEffort[] = [
      { durationSec: 240, distanceM: 1000, velocityMps: 1000 / 240 },
      { durationSec: 750, distanceM: 3000, velocityMps: 3000 / 750 },
    ];
    const anchor = deriveAnchor(efforts);

    expect(anchor.anchorSource).not.toBe("none");
    expect(anchor.vdot).not.toBeNull();
    expect(anchor.predictedRaces).toHaveLength(4);

    const byDistance = new Map(anchor.predictedRaces.map((r) => [r.distanceM, r.timeSec]));
    expect(byDistance.get(FIVE_K)!).toBeLessThan(byDistance.get(TEN_K)!);
    expect(byDistance.get(TEN_K)!).toBeLessThan(byDistance.get(HALF)!);
    expect(byDistance.get(HALF)!).toBeLessThan(byDistance.get(MARATHON)!);

    expect(byDistance.get(MARATHON)!).toBeGreaterThan(toSec("2:00:00"));
    expect(byDistance.get(MARATHON)!).toBeLessThan(toSec("5:00:00"));
  });

  test("a single short rep is not enough to anchor (returns none)", () => {
    const anchor = deriveAnchor([{ durationSec: 45, distanceM: 200, velocityMps: 200 / 45 }]);
    expect(anchor.anchorSource).toBe("none");
    expect(anchor.predictedRaces).toHaveLength(0);
  });
});
