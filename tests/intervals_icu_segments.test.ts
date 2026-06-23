import { describe, expect, it } from "bun:test";
import { buildSegmentsFromIntervalsIcu } from "../src/services/intervals_icu_segments";
import type { IIntervalsInterval } from "../src/types/intervals/IIntervalsActivity";
import type { StreamSet } from "../src/types/strava/IStream";

type Streams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

/** 1 Hz streams from a speed(t) profile; distance is the running integral. */
function streams(speedAt: (t: number) => number, dur: number): Streams {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  let d = 0;
  for (let t = 0; t <= dur; t++) {
    time.push(t);
    distance.push(d);
    heartrate.push(speedAt(t) > 3 ? 170 : 120);
    d += speedAt(t);
  }
  return { time: { data: time }, distance: { data: distance }, heartrate: { data: heartrate } };
}

function iv(type: string, elapsed: number, distance: number): IIntervalsInterval {
  return {
    type,
    elapsed_time: elapsed,
    moving_time: elapsed,
    distance,
    average_heartrate: type.toUpperCase().includes("WORK") ? 170 : 120,
  } as unknown as IIntervalsInterval;
}

describe("buildSegmentsFromIntervalsIcu", () => {
  it("maps WORK/RECOVERY blocks to INTERVALS/REST with warmup + cooldown", () => {
    // warmup 600s, 4×(200m work / 60s recovery), cooldown 300s
    const speed = (t: number) => {
      if (t < 600) return 2.0;
      if (t >= 600 && t < 1640) {
        const into = t - 600;
        return into % 260 < 200 ? 4.5 : 1.0;
      }
      return 1.5;
    };
    const s = streams(speed, 1940);
    const intervals: IIntervalsInterval[] = [iv("RECOVERY", 600, 1200)];
    for (let i = 0; i < 4; i++) {
      intervals.push(iv("WORK", 200, 900));
      intervals.push(iv("RECOVERY", 60, 60));
    }
    intervals.push(iv("RECOVERY", 300, 450));

    const segs = buildSegmentsFromIntervalsIcu(1, intervals, s);
    expect(segs).not.toBeNull();
    expect(segs![0].type).toBe("WARMUP");
    expect(segs![segs!.length - 1].type).toBe("COOL_DOWN");
    expect(segs!.filter((x) => x.type === "INTERVALS").length).toBe(4);
    // warmup spans roughly the leading 600s, not crushed
    expect(segs![0].timeSeriesEndTime).toBeGreaterThan(560);
    expect(segs![0].timeSeriesEndTime).toBeLessThan(640);
    // work reps read elevated HR
    const work = segs!.filter((x) => x.type === "INTERVALS");
    expect(work.every((w) => (w.avgHeartRate ?? 0) > 150)).toBe(true);
  });

  it("returns null when there is no WORK block (caller falls back)", () => {
    const s = streams(() => 2.0, 600);
    const intervals = [iv("RECOVERY", 300, 600), iv("RECOVERY", 300, 600)];
    expect(buildSegmentsFromIntervalsIcu(1, intervals, s)).toBeNull();
  });

  it("returns null on empty intervals", () => {
    const s = streams(() => 2.0, 100);
    expect(buildSegmentsFromIntervalsIcu(1, [], s)).toBeNull();
  });
});
