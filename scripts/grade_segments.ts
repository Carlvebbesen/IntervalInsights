/**
 * OFFLINE grading harness for the interval-segmentation cascade.
 *
 * Runs the CURRENT `buildSegmentsDeterministic` against the activity dumps in
 * knowledge/sources/activity-dumps, two ways per fixture:
 *   (a) known structure (from the title), and
 *   (b) inference (no structure — empty userSets),
 * then grades mode / confidence / warmup-end / rep-count / work-vs-rest
 * speed & HR separation, and diffs against the PERSISTED proposedSegments in
 * the dump (the possibly-stale draft).
 *
 * This mirrors the 2026-06-23 "item 6" live verification, but offline against
 * a fixed corpus. It deliberately calls the deterministic segmenter rung in
 * isolation (NOT the full `produceSegments` cascade): the grading metrics
 * (mode, confidence) are deterministic-segmenter outputs, and the cascade would
 * short-circuit to the intervals.icu rung for the linked fixtures.
 *
 * Run:  bun run scripts/grade_segments.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSegmentsDeterministic,
  classifyLaps,
  deriveSpeed,
  flattenReps,
  type SegmentMode,
} from "../src/services/deterministic_segmenter";
import { generateCompleteIntervalSet } from "../src/services/utils";
import type { workoutSet } from "../src/agent/initial_analysis_agent";
import type { ExpandedIntervalSet } from "../src/types/ExpandedIntervalSet";
import type { InsertIntervalSegment } from "../src/schema/interval_segments";
import type { Lap } from "../src/types/strava/IDetailedActivity";
import type { StreamSet } from "../src/types/strava/IStream";
import type { z } from "zod";

const DUMP_DIR =
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";
const OUT_PATH = join(DUMP_DIR, "SEGMENTATION_GRADES.md");

type WorkoutSet = z.infer<typeof workoutSet>;

type StatsStreams = Required<Pick<StreamSet, "time" | "distance">> & Pick<StreamSet, "heartrate">;

// ── Fixture catalogue: title-derived expected structure + expected rep count ──
// Structures use the same `workoutSet` shape the initial agent emits, expanded
// via `generateCompleteIntervalSet` exactly like `proposeSegments` does.
interface Fixture {
  id: number;
  label: string;
  expectedReps: number;
  expectedMode: SegmentMode | null; // anchor from June-23, where known
  expectedWarmup: number | null; // anchor (s), where known
  /** Known structure from the title. `null` => no structure even in known path (unknown title). */
  structure: WorkoutSet[] | null;
}

const timeStep = (reps: number, work: number, rest: number): WorkoutSet => ({
  set_reps: 1,
  steps: [{ reps, work_type: "TIME", work_value: work, recovery_type: "TIME", recovery_value: rest }],
  set_recovery: 0,
});
const distStep = (reps: number, dist: number, rest: number): WorkoutSet => ({
  set_reps: 1,
  steps: [
    { reps, work_type: "DISTANCE", work_value: dist, recovery_type: "TIME", recovery_value: rest },
  ],
  set_recovery: 0,
});

const FIXTURES: Fixture[] = [
  // SHORT_INTERVALS time-based
  { id: 503, label: "6×(360s/60s) [3 laps]", expectedReps: 6, expectedMode: "boundary", expectedWarmup: 932, structure: [timeStep(6, 360, 60)] },
  { id: 504, label: "20×(45s/15s) [1 lap]", expectedReps: 20, expectedMode: "unusable", expectedWarmup: 437, structure: [timeStep(20, 45, 15)] },
  { id: 509, label: "20×(45/15) [4 laps]", expectedReps: 20, expectedMode: "boundary", expectedWarmup: 787, structure: [timeStep(20, 45, 15)] },
  { id: 608, label: "20×(45/15) [5 laps]", expectedReps: 20, expectedMode: null, expectedWarmup: null, structure: [timeStep(20, 45, 15)] },
  { id: 625, label: "30×(45/15) [5 laps]", expectedReps: 30, expectedMode: null, expectedWarmup: null, structure: [timeStep(30, 45, 15)] },
  { id: 47, label: "15×(90s/30s) [4 laps]", expectedReps: 15, expectedMode: null, expectedWarmup: null, structure: [timeStep(15, 90, 30)] },
  // distance-based
  { id: 505, label: "8×1000m [17 laps]", expectedReps: 8, expectedMode: null, expectedWarmup: null, structure: [distStep(8, 1000, 90)] },
  { id: 506, label: "6×1000m [13 laps]", expectedReps: 6, expectedMode: null, expectedWarmup: null, structure: [distStep(6, 1000, 90)] },
  { id: 626, label: "10×1000m [21 laps]", expectedReps: 10, expectedMode: null, expectedWarmup: null, structure: [distStep(10, 1000, 90)] },
  { id: 508, label: "5×2000m [11 laps]", expectedReps: 5, expectedMode: null, expectedWarmup: null, structure: [distStep(5, 2000, 120)] },
  { id: 615, label: "5×3000m [4 laps]", expectedReps: 5, expectedMode: null, expectedWarmup: null, structure: [distStep(5, 3000, 120)] },
  // pyramid: 3×(3000,2000,1000m)
  {
    id: 510,
    label: "3×(3000,2000,1000m) pyramid [19 laps]",
    expectedReps: 9,
    expectedMode: null,
    expectedWarmup: null,
    structure: [
      {
        set_reps: 3,
        steps: [
          { reps: 1, work_type: "DISTANCE", work_value: 3000, recovery_type: "TIME", recovery_value: 120 },
          { reps: 1, work_type: "DISTANCE", work_value: 2000, recovery_type: "TIME", recovery_value: 60 },
          { reps: 1, work_type: "DISTANCE", work_value: 1000, recovery_type: "TIME", recovery_value: 60 },
        ],
        set_recovery: 60,
      },
    ],
  },
  // unknown titles — no title-derived structure; both paths inference-only
  { id: 507, label: 'unknown "What a feeling" [13 laps]', expectedReps: 0, expectedMode: null, expectedWarmup: null, structure: null },
  { id: 635, label: 'unknown "Monsterøkt" [19 laps]', expectedReps: 0, expectedMode: null, expectedWarmup: null, structure: null },
];

interface Dump {
  db: {
    activity: {
      id: number;
      title?: string;
      trainingType?: string | null;
      indoor?: boolean;
      sportType?: string;
      draftAnalysisResult?: {
        structure?: WorkoutSet[] | null;
        proposedSegments?: PersistedSeg[] | null;
      } | null;
    };
  };
  pipeline: {
    streams: Record<string, number[] | null>;
    laps: Lap[] | null;
  };
}

interface PersistedSeg {
  segmentIndex: number;
  setGroupIndex: number;
  type: string;
  timeSeriesEndTime: number;
  actualDistance: number;
  actualDuration: number;
  avgHeartRate: number | null;
  targetType: string;
  targetValue: number;
  targetPace: number | null;
}

function loadDump(id: number): Dump {
  return JSON.parse(readFileSync(join(DUMP_DIR, `activity-${id}.json`), "utf8"));
}

/** Wrap a flattened number[] (or null) as a stream `{data}`; null stays undefined. */
function wrap(arr: number[] | null | undefined): { data: number[] } | undefined {
  return Array.isArray(arr) ? { data: arr } : undefined;
}

/** Rebuild the StreamSet the segmenter expects from the dump's flattened streams. */
function reconstructStreams(s: Record<string, number[] | null>): StatsStreams {
  const time = wrap(s.time);
  const distance = wrap(s.distance);
  if (!time || !distance) throw new Error("dump missing time/distance streams");
  return {
    time,
    distance,
    heartrate: wrap(s.heartrate),
    // velocity_smooth is what the segmenter reads; dump flattens it as `velocity`.
    velocity_smooth: wrap(s.velocity),
    cadence: wrap(s.cadence),
    altitude: wrap(s.altitude),
    watts: wrap(s.watts),
  } as StatsStreams;
}

const round = (n: number, d = 0): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const fmtPace = (mps: number): string => {
  if (mps <= 0) return "-";
  const spk = 1000 / mps;
  const m = Math.floor(spk / 60);
  const sec = Math.round(spk % 60);
  return `${m}:${sec.toString().padStart(2, "0")}/km`;
};

const warmupEnd = (segs: InsertIntervalSegment[]): number | null => {
  const w = segs.find((s) => s.type === "WARMUP");
  return w ? w.timeSeriesEndTime : null;
};
const persistedWarmupEnd = (segs: PersistedSeg[]): number | null => {
  const w = segs.find((s) => s.type === "WARMUP");
  return w ? w.timeSeriesEndTime : null;
};
const countReps = (types: string[]): number =>
  types.filter((t) => t === "INTERVALS").length;

/**
 * Mean work-speed vs mean rest-speed, and mean work-HR vs mean rest-HR, computed
 * the same way the app would: re-derive windowed speed, then average each sample
 * inside INTERVALS segments (work) vs inside REST/ACTIVE_REST segments (rest).
 */
function separation(
  segs: InsertIntervalSegment[],
  streams: StatsStreams,
): { workSpd: number; restSpd: number; workHr: number | null; restHr: number | null } {
  const time = streams.time.data;
  const speed = deriveSpeed(time, streams.distance.data);
  const hr = streams.heartrate?.data;
  const inType = (t: number, types: string[]): boolean =>
    segs.some(
      (s) =>
        types.includes(s.type) &&
        t > s.timeSeriesEndTime - s.actualDuration &&
        t <= s.timeSeriesEndTime,
    );
  const ws: number[] = [];
  const rs: number[] = [];
  const wh: number[] = [];
  const rh: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (inType(t, ["INTERVALS"])) {
      ws.push(speed[i]);
      if (hr && hr[i] > 0) wh.push(hr[i]);
    } else if (inType(t, ["REST", "ACTIVE_REST"])) {
      rs.push(speed[i]);
      if (hr && hr[i] > 0) rh.push(hr[i]);
    }
  }
  const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    workSpd: avg(ws),
    restSpd: avg(rs),
    workHr: wh.length ? Math.round(avg(wh)) : null,
    restHr: rh.length ? Math.round(avg(rh)) : null,
  };
}

interface RunResult {
  ran: boolean;
  mode: SegmentMode | "null-result";
  confidence: number;
  warmup: number | null;
  reps: number;
  workSpd: number;
  restSpd: number;
  workHr: number | null;
  restHr: number | null;
  segCount: number;
}

function runOne(
  id: number,
  laps: Lap[],
  userSets: ExpandedIntervalSet[],
  streams: StatsStreams,
): RunResult {
  const res = buildSegmentsDeterministic(id, laps, userSets, streams);
  if (!res) {
    return {
      ran: false,
      mode: "null-result",
      confidence: 0,
      warmup: null,
      reps: 0,
      workSpd: 0,
      restSpd: 0,
      workHr: null,
      restHr: null,
      segCount: 0,
    };
  }
  const sep = separation(res.segments, streams);
  return {
    ran: true,
    mode: res.mode,
    confidence: res.confidence,
    warmup: warmupEnd(res.segments),
    reps: countReps(res.segments.map((s) => s.type)),
    ...sep,
    segCount: res.segments.length,
  };
}

interface Row {
  fx: Fixture;
  known: RunResult | null; // null when no title structure
  inferred: RunResult;
  classifiedMode: SegmentMode | "n/a";
  persistedWarmup: number | null;
  persistedReps: number;
  persistedCount: number;
}

function gradeFixture(fx: Fixture): Row {
  const dump = loadDump(fx.id);
  const streams = reconstructStreams(dump.pipeline.streams);
  const laps = dump.pipeline.laps ?? [];

  // classify laps once for the report (mode the deterministic segmenter would
  // pick before inference flips it to "inferred").
  const cls = classifyLaps(laps, streams.time.data);

  // Known-structure path: prefer the title-derived structure; verify it agrees
  // with the persisted draft structure when present (informational).
  let known: RunResult | null = null;
  if (fx.structure) {
    const userSets = generateCompleteIntervalSet(fx.structure);
    known = runOne(fx.id, laps, userSets, streams);
  }

  // Inference path: no structure at all.
  const inferred = runOne(fx.id, laps, [], streams);

  const persisted = dump.db.activity.draftAnalysisResult?.proposedSegments ?? [];

  return {
    fx,
    known,
    inferred,
    classifiedMode: laps.length ? cls.mode : "n/a",
    persistedWarmup: persistedWarmupEnd(persisted),
    persistedReps: countReps(persisted.map((s) => s.type)),
    persistedCount: persisted.length,
  };
}

// ── self-check gate ────────────────────────────────────────────────────────
interface Anchor {
  mode: SegmentMode;
  warmup: number;
  reps: number;
  conf: number;
}
const ANCHORS: Record<number, Anchor> = {
  503: { mode: "boundary", warmup: 932, reps: 6, conf: 0.96 },
  509: { mode: "boundary", warmup: 787, reps: 20, conf: 0.79 },
  504: { mode: "unusable", warmup: 437, reps: 20, conf: 0.96 },
};

function checkAnchors(rows: Row[]): string[] {
  const notes: string[] = [];
  for (const r of rows) {
    const a = ANCHORS[r.fx.id];
    if (!a || !r.known) continue;
    const k = r.known;
    const modeOk = k.mode === a.mode;
    const warmOk = k.warmup != null && Math.abs(k.warmup - a.warmup) <= 60;
    const repsOk = k.reps === a.reps;
    const confOk = Math.abs(k.confidence - a.conf) <= 0.15;
    const ok = modeOk && warmOk && repsOk && confOk;
    notes.push(
      `${ok ? "PASS" : "FAIL"} ${r.fx.id}: mode ${k.mode}${modeOk ? "" : `≠${a.mode}`}, ` +
        `warmup ${k.warmup}s${warmOk ? "" : ` (anchor ${a.warmup})`}, ` +
        `reps ${k.reps}${repsOk ? "" : `≠${a.reps}`}, ` +
        `conf ${round(k.confidence, 2)}${confOk ? "" : ` (anchor ${a.conf})`}`,
    );
  }
  return notes;
}

// ── report rendering ─────────────────────────────────────────────────────────
function fmtRun(r: RunResult | null): {
  mode: string;
  warmup: string;
  conf: string;
  spd: string;
  hr: string;
} {
  if (!r) return { mode: "—", warmup: "—", conf: "—", spd: "—", hr: "—" };
  if (!r.ran) return { mode: "null→LLM", warmup: "—", conf: "0", spd: "—", hr: "—" };
  return {
    mode: r.mode,
    warmup: r.warmup == null ? "none" : `${round(r.warmup)}s`,
    conf: round(r.confidence, 2).toFixed(2),
    spd: `${round(r.workSpd, 2)}/${round(r.restSpd, 2)} (${fmtPace(r.workSpd)})`,
    hr: r.workHr == null ? "—" : `${r.workHr}/${r.restHr ?? "—"}`,
  };
}

function passFail(fx: Fixture, known: RunResult | null, inferred: RunResult): string {
  // A fixture "passes" the known-structure path if it produced segments with the
  // expected rep count (deterministic rung handled it). Anchored fixtures must
  // also match mode + warmup within tolerance.
  if (!fx.structure) {
    // unknown-title: only inference is meaningful
    return inferred.ran && inferred.reps > 0 ? "inference-only (no title)" : "FAIL (no segments)";
  }
  if (!known || !known.ran) return "FAIL (null result → LLM)";
  const repsOk = known.reps === fx.expectedReps;
  if (fx.expectedMode) {
    const modeOk = known.mode === fx.expectedMode;
    const warmOk =
      fx.expectedWarmup == null ||
      (known.warmup != null && Math.abs(known.warmup - fx.expectedWarmup) <= 60);
    return repsOk && modeOk && warmOk ? "PASS" : "FAIL";
  }
  return repsOk ? "PASS" : `WARN (reps ${known.reps}≠${fx.expectedReps})`;
}

function buildReport(rows: Row[], anchorNotes: string[]): string {
  const lines: string[] = [];
  lines.push("# Segmentation grades — offline harness");
  lines.push("");
  lines.push(
    "Generated by `scripts/grade_segments.ts` (run `bun run scripts/grade_segments.ts`). " +
      "Grades the **current** `buildSegmentsDeterministic` against the activity dumps, two ways " +
      "per fixture: **known** structure (title-derived) and **inference** (no structure). " +
      "Speed columns are mean work / mean rest m/s (work pace in parens); HR columns are mean " +
      "work / mean rest bpm. `vs-draft` compares against the persisted (possibly stale) " +
      "`proposedSegments` in each dump.",
  );
  lines.push("");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}. Fixtures: ${rows.length}.`);
  lines.push("");

  // self-check
  lines.push("## Self-check (trust gate)");
  lines.push("");
  lines.push("June-23 known-structure anchors (503 boundary/932s/6/0.96, 509 boundary/787s/20/0.79, 504 unusable/437s/20/0.96):");
  lines.push("");
  for (const n of anchorNotes) lines.push(`- ${n}`);
  lines.push("");

  // main grade table
  lines.push("## Grade table");
  lines.push("");
  lines.push(
    "| Fix | Structure | Path | Mode | WarmupEnd | Reps det/exp | Conf | Work/Rest speed (pace) | Work/Rest HR | vs-draft |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const draftDelta =
      r.persistedCount === 0
        ? "no draft"
        : `wu ${r.persistedWarmup ?? "—"}s, reps ${r.persistedReps}, ${r.persistedCount} segs`;
    const expReps = r.fx.structure ? r.fx.expectedReps : "—";

    if (r.known) {
      const k = fmtRun(r.known);
      lines.push(
        `| ${r.fx.id} | ${r.fx.label} | known | ${k.mode} | ${k.warmup} | ${r.known.reps}/${expReps} | ${k.conf} | ${k.spd} | ${k.hr} | ${draftDelta} |`,
      );
    }
    const inf = fmtRun(r.inferred);
    const infExp = r.fx.structure ? "(infer)" : expReps;
    lines.push(
      `| ${r.fx.id} | ${r.known ? "↑" : r.fx.label} | inference | ${inf.mode} | ${inf.warmup} | ${r.inferred.reps}/${infExp} | ${inf.conf} | ${inf.spd} | ${inf.hr} | ${r.known ? "↑" : draftDelta} |`,
    );
  }
  lines.push("");

  // pass/fail summary
  lines.push("## Pass / fail (known-structure path)");
  lines.push("");
  lines.push("| Fix | Verdict | Detected mode | Reps det/exp | Warmup | Notes |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const v = passFail(r.fx, r.known, r.inferred);
    const k = r.known;
    const detMode = k && k.ran ? k.mode : r.fx.structure ? "null→LLM" : "n/a";
    const reps = k ? `${k.reps}/${r.fx.expectedReps}` : `—/${r.fx.expectedReps || "—"}`;
    const wu = k && k.warmup != null ? `${round(k.warmup)}s` : "—";
    const note = r.fx.expectedWarmup ? `anchor ${r.fx.expectedWarmup}s` : "";
    lines.push(`| ${r.fx.id} | ${v} | ${detMode} | ${reps} | ${wu} | ${note} |`);
  }
  lines.push("");

  // weakest cases
  lines.push("## Weak / watch cases");
  lines.push("");
  const weak: string[] = [];
  for (const r of rows) {
    // 504 single-lap inference over-detection
    if (r.fx.id === 504 && r.inferred.ran) {
      weak.push(
        `**504 inference** (single-lap): ${r.inferred.reps} reps vs 20 expected, ` +
          `warmup ${r.inferred.warmup ?? "none"}, conf ${round(r.inferred.confidence, 2)} — ` +
          `${r.inferred.reps > 20 ? "OVER-DETECTS (known soft spot)" : "ok"}.`,
      );
    }
    // warmup crushed to ~60s (regression of the original bug) on known path
    if (r.known?.ran && r.known.warmup != null && r.known.warmup <= 70 && r.fx.expectedReps > 0) {
      weak.push(
        `**${r.fx.id} known**: warmup crushed to ${round(r.known.warmup)}s — looks like the old 60s bug.`,
      );
    }
    if (r.inferred.ran && r.inferred.warmup != null && r.inferred.warmup <= 70) {
      weak.push(`**${r.fx.id} inference**: warmup ${round(r.inferred.warmup)}s (≤70s — watch).`);
    }
    // known path fell through to LLM
    if (r.fx.structure && (!r.known || !r.known.ran)) {
      weak.push(`**${r.fx.id} known**: null result → would fall to LLM.`);
    }
    // big rep mismatch on known path
    if (r.known?.ran && r.fx.expectedReps > 0 && r.known.reps !== r.fx.expectedReps) {
      weak.push(
        `**${r.fx.id} known**: rep count ${r.known.reps} ≠ ${r.fx.expectedReps} expected (${r.known.mode}).`,
      );
    }
  }
  if (weak.length === 0) weak.push("None flagged.");
  for (const w of weak) lines.push(`- ${w}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "_Note: the harness calls the deterministic segmenter rung directly. In the live " +
      "`produceSegments` cascade, fixtures linked to intervals.icu (503/504/509/608/615/47 have " +
      "icu blocks) would be segmented by the intervals.icu rung first; the deterministic rung " +
      "shown here is what fires for the indoor/dense/one-big-lap path and what the June-23 " +
      "verification measured._",
  );
  return lines.join("\n");
}

function main(): void {
  const rows = FIXTURES.map(gradeFixture);
  const anchorNotes = checkAnchors(rows);

  // console summary
  console.log("\n=== SEGMENTATION GRADES (deterministic rung, offline) ===\n");
  for (const n of anchorNotes) console.log("  [self-check] " + n);
  console.log("");
  const pad = (s: string, n: number): string => s.padEnd(n).slice(0, n);
  console.log(
    pad("fix", 5) +
      pad("path", 11) +
      pad("mode", 11) +
      pad("warmup", 9) +
      pad("reps", 9) +
      pad("conf", 6) +
      pad("workSpd/restSpd", 18) +
      pad("workHr/restHr", 14),
  );
  for (const r of rows) {
    const render = (label: string, run: RunResult | null, exp: number | string): void => {
      if (!run) return;
      const f = fmtRun(run);
      console.log(
        pad(String(r.fx.id), 5) +
          pad(label, 11) +
          pad(f.mode, 11) +
          pad(f.warmup, 9) +
          pad(`${run.ran ? run.reps : 0}/${exp}`, 9) +
          pad(f.conf, 6) +
          pad(`${round(run.workSpd, 2)}/${round(run.restSpd, 2)}`, 18) +
          pad(`${run.workHr ?? "-"}/${run.restHr ?? "-"}`, 14),
      );
    };
    render("known", r.known, r.fx.expectedReps);
    render("inference", r.inferred, r.fx.structure ? "infer" : "?");
  }

  const report = buildReport(rows, anchorNotes);
  writeFileSync(OUT_PATH, report, "utf8");
  console.log(`\nReport written to ${OUT_PATH}\n`);
}

main();
