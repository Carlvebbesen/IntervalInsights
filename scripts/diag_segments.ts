/**
 * Per-rep ALIGNMENT diagnostic for buildSegmentsDeterministic (offline, no DB/LLM).
 *
 * grade_segments.ts checks rep COUNT/mode/warmup — but the 622 fartlek bug keeps
 * the right count (15 reps) while mislabelling targets (a 175s effort tagged the
 * "60s" rep). This harness measures the thing that actually breaks: for each
 * INTERVALS segment, prescribed target vs measured actual, and an alignment score.
 *
 * Run: IDS=505,510,620,622 bun run scripts/diag_segments.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSegmentsDeterministic,
  classifyLaps,
} from "../src/services/deterministic_segmenter";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { workoutSet } from "../src/agent/initial_analysis_agent";
import type { StreamSet } from "../src/types/strava/IStream";
import type { Lap } from "../src/types/strava/IDetailedActivity";
import type { z } from "zod";

type WorkoutSet = z.infer<typeof workoutSet>;
type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

const DUMP_DIR =
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";

const timeStep = (reps: number, work: number, rest: number): WorkoutSet["steps"][number] => ({
  reps,
  work_type: "TIME",
  work_value: work,
  recovery_type: "TIME",
  recovery_value: rest,
});
const distStep = (reps: number, dist: number, rest: number): WorkoutSet["steps"][number] => ({
  reps,
  work_type: "DISTANCE",
  work_value: dist,
  recovery_type: "TIME",
  recovery_value: rest,
});

interface Fix {
  id: number;
  label: string;
  structure: WorkoutSet[];
}

const FIXTURES: Fix[] = [
  { id: 505, label: "8x1000m (outdoor, DIST)", structure: [{ set_reps: 1, set_recovery: 0, steps: [distStep(8, 1000, 90)] }] },
  {
    id: 510,
    label: "3x(3,2,1km) pyramid (outdoor, DIST)",
    structure: [
      {
        set_reps: 3,
        set_recovery: 60,
        steps: [distStep(1, 3000, 120), distStep(1, 2000, 60), distStep(1, 1000, 60)],
      },
    ],
  },
  {
    id: 620,
    label: "4x(3,2,1min) (indoor, TIME)",
    structure: [
      {
        set_reps: 4,
        set_recovery: 60,
        steps: [timeStep(1, 180, 60), timeStep(1, 120, 60), timeStep(1, 60, 60)],
      },
    ],
  },
  {
    id: 622,
    label: "5x(3,2,1min) fartlek (indoor, TIME) [TARGET]",
    structure: [
      {
        set_reps: 5,
        set_recovery: 60,
        steps: [timeStep(1, 180, 60), timeStep(1, 120, 60), timeStep(1, 60, 60)],
      },
    ],
  },
];

function wrap(arr: number[] | null | undefined): { data: number[] } | undefined {
  return Array.isArray(arr) ? { data: arr } : undefined;
}
function reconstructStreams(s: Record<string, number[] | null>): StatsStreams {
  const time = wrap(s.time);
  const distance = wrap(s.distance);
  if (!time || !distance) throw new Error("dump missing time/distance");
  return {
    time,
    distance,
    heartrate: wrap(s.heartrate),
    velocity_smooth: wrap(s.velocity),
    cadence: wrap(s.cadence),
    altitude: wrap(s.altitude),
    watts: wrap(s.watts),
  } as StatsStreams;
}

const fmtTgt = (t: string, v: number): string => (t === "time" ? `${v}s` : `${v}m`);

function run(fx: Fix): void {
  const dump = JSON.parse(readFileSync(join(DUMP_DIR, `activity-${fx.id}.json`), "utf8"));
  const streams = reconstructStreams(dump.pipeline.streams);
  const laps: Lap[] = dump.pipeline.laps ?? [];
  const userSets = generateCompleteIntervalSet(fx.structure);
  const cls = classifyLaps(laps, streams.time.data);
  const res = buildSegmentsDeterministic(fx.id, laps, userSets, streams);

  console.log(`\n===== ${fx.id} ${fx.label} =====`);
  console.log(`laps=${laps.length} clsMode=${cls.mode} workLaps=${cls.workLaps.length}`);
  if (!res) {
    console.log("  buildSegmentsDeterministic → null (would fall to LLM)");
    return;
  }
  console.log(`mode=${res.mode} confidence=${res.confidence.toFixed(2)} segs=${res.segments.length}`);

  const intervals = res.segments.filter((s) => s.type === "INTERVALS");
  let aligned = 0;
  for (const s of intervals) {
    const tgt = s.targetType === "time" ? s.targetValue : s.targetValue;
    const actual = s.targetType === "time" ? Math.round(s.actualDuration ?? 0) : Math.round(s.actualDistance ?? 0);
    const ratio = tgt > 0 ? actual / tgt : 0;
    const ok = ratio >= 0.7 && ratio <= 1.4;
    if (ok) aligned++;
    console.log(
      `  set=${s.setGroupIndex} tgt=${fmtTgt(s.targetType ?? "", tgt).padEnd(6)} actual=${String(actual).padStart(5)}${s.targetType === "time" ? "s" : "m"} ratio=${ratio.toFixed(2)} ${ok ? "ok" : "✗ MISALIGNED"}`,
    );
  }
  const score = intervals.length ? aligned / intervals.length : 0;
  console.log(`ALIGNMENT: ${aligned}/${intervals.length} (${(score * 100).toFixed(0)}%)`);
}

const IDS = (process.env.IDS ? process.env.IDS.split(",").map(Number) : FIXTURES.map((f) => f.id));
for (const id of IDS) {
  const fx = FIXTURES.find((f) => f.id === id);
  if (!fx) {
    console.log(`\n[skip] ${id}: no fixture structure defined`);
    continue;
  }
  try {
    run(fx);
  } catch (e) {
    console.log(`\n[err] ${id}: ${e instanceof Error ? e.message : e}`);
  }
}
