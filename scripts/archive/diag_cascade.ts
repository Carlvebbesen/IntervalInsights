/**
 * Cascade-level segmentation diagnostic (offline, no DB, NO LLM spend).
 *
 * Replicates produceSegments' rung order EXACTLY (icu → laps → deterministic),
 * but stops before rung 4 (LLM) and just reports "would call LLM". This shows
 * which rung actually wins in production and the per-rep target-vs-actual
 * alignment of the FINAL segments — the metric the 622 fartlek bug breaks
 * (right rep count, scrambled targets). Use to prove a fix lands end-to-end and
 * regresses nothing.
 *
 * Run: IDS=505,510,620,622,616,626 bun run scripts/diag_cascade.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSegmentsDeterministic } from "../src/services/deterministic_segmenter";
import { buildSegmentsFromIntervalsIcu } from "../src/services/intervals_icu_segments";
import { buildSegmentsFromLaps, structureShapeMatches } from "../src/services/lap_derivation_service";
import { ensureWarmupFirst } from "../src/agent/segment_production";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { workoutSet } from "../src/agent/initial_analysis_agent";
import type { InsertIntervalSegment } from "../src/schema/interval_segments";
import type { StreamSet } from "../src/types/strava/IStream";
import type { Lap } from "../src/types/strava/IDetailedActivity";
import type { IIntervalsInterval } from "../src/types/intervals/IIntervalsActivity";
import type { z } from "zod";

type WorkoutSet = z.infer<typeof workoutSet>;
type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

const DUMP_DIR =
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";

const tStep = (reps: number, work: number, rest: number): WorkoutSet["steps"][number] => ({
  reps,
  work_type: "TIME",
  work_value: work,
  recovery_type: "TIME",
  recovery_value: rest,
});
const dStep = (reps: number, dist: number, rest: number): WorkoutSet["steps"][number] => ({
  reps,
  work_type: "DISTANCE",
  work_value: dist,
  recovery_type: "TIME",
  recovery_value: rest,
});
const oneSet = (steps: WorkoutSet["steps"], setReps = 1, setRecovery = 0): WorkoutSet => ({
  set_reps: setReps,
  set_recovery: setRecovery,
  steps,
});

interface Fix {
  id: number;
  label: string;
  structure: WorkoutSet[];
}

const FIXTURES: Fix[] = [
  { id: 505, label: "8x1000m (outdoor DIST)", structure: [oneSet([dStep(8, 1000, 90)])] },
  { id: 510, label: "3x(3,2,1km) pyramid (outdoor DIST)", structure: [oneSet([dStep(1, 3000, 120), dStep(1, 2000, 60), dStep(1, 1000, 60)], 3, 60)] },
  { id: 620, label: "4x(3,2,1min) (indoor TIME, icu)", structure: [oneSet([tStep(1, 180, 60), tStep(1, 120, 60), tStep(1, 60, 60)], 4, 60)] },
  { id: 622, label: "5x(3,2,1min) fartlek (indoor TIME, icu) [TARGET]", structure: [oneSet([tStep(1, 180, 60), tStep(1, 120, 60), tStep(1, 60, 60)], 5, 60)] },
  { id: 626, label: "10x1000m (indoor DIST, icu)", structure: [oneSet([dStep(10, 1000, 90)])] },
  { id: 616, label: "4x1000m + 20x(45/15) compound (indoor)", structure: [oneSet([dStep(4, 1000, 60)]), oneSet([tStep(20, 45, 15)])] },
];

function wrap(arr: number[] | null | undefined): { data: number[] } | undefined {
  return Array.isArray(arr) ? { data: arr } : undefined;
}
function reconstruct(dump: any): { stats: StatsStreams; full: StreamSet } {
  const s = dump.pipeline.streams;
  const time = wrap(s.time);
  const distance = wrap(s.distance);
  if (!time || !distance) throw new Error("dump missing time/distance");
  const full = {
    time,
    distance,
    heartrate: wrap(s.heartrate),
    velocity_smooth: wrap(s.velocity),
    cadence: wrap(s.cadence),
    altitude: wrap(s.altitude),
    watts: wrap(s.watts),
    latlng: wrap(s.latlng),
    moving: wrap(s.moving),
    grade_smooth: wrap(s.grade),
  } as unknown as StreamSet;
  return { stats: full as StatsStreams, full };
}

/** Local copy of segment_production.countStructureReps (not exported). */
function countStructureReps(structure: WorkoutSet[] | undefined): number | undefined {
  if (!structure || structure.length === 0) return undefined;
  let n = 0;
  for (const set of structure) {
    const stepReps = set.steps.reduce((s, st) => s + (st.reps ?? 1), 0);
    n += (set.set_reps ?? 1) * stepReps;
  }
  return n > 0 ? n : undefined;
}

const DET_THRESHOLD = 0.5;

function runCascade(fx: Fix): { rung: string; segs: InsertIntervalSegment[]; conf?: number } {
  const dump = JSON.parse(readFileSync(join(DUMP_DIR, `activity-${fx.id}.json`), "utf8"));
  const { stats, full } = reconstruct(dump);
  const laps: Lap[] = dump.pipeline.laps ?? [];
  const icu: IIntervalsInterval[] | null = dump.intervalsIcuRaw?.intervals ?? null;
  const userSets = generateCompleteIntervalSet(fx.structure);
  const t0 = stats.time.data[0] ?? 0;

  // rung 1 — intervals.icu
  if (icu && icu.length > 0) {
    const expectedReps = countStructureReps(fx.structure);
    const fromIcu = buildSegmentsFromIntervalsIcu(fx.id, icu, stats, "", expectedReps);
    if (fromIcu) return { rung: "icu", segs: ensureWarmupFirst(fromIcu, fx.id, t0) };
  }
  // rung 2 — lap-derived
  if (structureShapeMatches(fx.structure, userSets) && laps.length > 0) {
    const fromLaps = buildSegmentsFromLaps(fx.id, laps, userSets, stats, "");
    if (fromLaps) return { rung: "laps", segs: ensureWarmupFirst(fromLaps, fx.id, t0) };
  }
  // rung 3 — deterministic
  const det = buildSegmentsDeterministic(fx.id, laps, userSets, stats);
  if (det && det.confidence >= DET_THRESHOLD) {
    return { rung: "deterministic", segs: ensureWarmupFirst(det.segments, fx.id, t0), conf: det.confidence };
  }
  return { rung: det ? `LLM(lowconf ${det.confidence.toFixed(2)})` : "LLM(null)", segs: [] };
}

function report(fx: Fix): void {
  const { rung, segs, conf } = runCascade(fx);
  console.log(`\n===== ${fx.id} ${fx.label} =====`);
  console.log(`RUNG=${rung}${conf != null ? ` conf=${conf.toFixed(2)}` : ""} segs=${segs.length}`);
  if (segs.length === 0) return;
  const intervals = segs.filter((s) => s.type === "INTERVALS");
  let aligned = 0;
  for (const s of intervals) {
    const isTime = s.targetType === "time";
    const actual = isTime ? Math.round(s.actualDuration ?? 0) : Math.round(s.actualDistance ?? 0);
    const ratio = s.targetValue > 0 ? actual / s.targetValue : 0;
    const ok = ratio >= 0.7 && ratio <= 1.4;
    if (ok) aligned++;
    console.log(
      `  set=${s.setGroupIndex} tgt=${(s.targetValue + (isTime ? "s" : "m")).padEnd(6)} actual=${String(actual).padStart(5)}${isTime ? "s" : "m"} ratio=${ratio.toFixed(2)} ${ok ? "ok" : "✗ MISALIGNED"}`,
    );
  }
  const score = intervals.length ? aligned / intervals.length : 0;
  console.log(`ALIGNMENT: ${aligned}/${intervals.length} (${(score * 100).toFixed(0)}%)`);
}

const IDS = process.env.IDS ? process.env.IDS.split(",").map(Number) : FIXTURES.map((f) => f.id);
for (const id of IDS) {
  const fx = FIXTURES.find((f) => f.id === id);
  if (!fx) {
    console.log(`\n[skip] ${id}: no fixture defined`);
    continue;
  }
  try {
    report(fx);
  } catch (e) {
    console.log(`\n[err] ${id}: ${e instanceof Error ? e.message : e}`);
  }
}
