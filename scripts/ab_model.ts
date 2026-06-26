/**
 * Model A/B for the reasoning-heavy classification+structure agent.
 *
 * For each fixture, reconstruct the EXACT context invokeActivityAnalysisAgent sees
 * in production (streams + title/desc + intervals.icu prediction) from the activity
 * dump, then run the agent on gpt-4o-mini vs gpt-4.1 vs o4-mini and grade
 * training-type + extracted rep count against the known-correct structure.
 *
 * COSTS LLM MONEY (Carl-approved). Run: bun run scripts/ab_model.ts
 */

import { sleep } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invokeActivityAnalysisAgent } from "../src/agent/initial_analysis_agent";
import { gptMiniModel, gptStrongModel, o4ReasoningModel } from "../src/agent/model";
import type { ChatOpenAI } from "@langchain/openai";
import type { StreamSet } from "../src/types/strava/IStream";

const DUMP_DIR =
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";

interface Fix {
  id: number;
  title: string;
  type: string;
  reps: number;
  note?: string;
}
// Known-correct training type + total work-rep count per fixture.
const FIXTURES: Fix[] = [
  { id: 503, title: "6x6min", type: "LONG_INTERVALS", reps: 6 },
  { id: 504, title: "20x45/15", type: "SHORT_INTERVALS", reps: 20 },
  { id: 505, title: "8x1000m", type: "LONG_INTERVALS", reps: 8 },
  { id: 509, title: "20x45/15", type: "SHORT_INTERVALS", reps: 20 },
  { id: 510, title: "3x(3,2,1km)", type: "LONG_INTERVALS", reps: 9 },
  { id: 612, title: "2x3,2,2km", type: "LONG_INTERVALS", reps: 6, note: "decimal-comma" },
  { id: 616, title: "4x1000m+20x45/15", type: "LONG_INTERVALS", reps: 24, note: "compound" },
  { id: 620, title: "4x(3,2,1min)", type: "LONG_INTERVALS", reps: 12 },
  { id: 622, title: "5x(3,2,1min)", type: "LONG_INTERVALS", reps: 15, note: "fartlek N×(a,b,c)" },
  { id: 629, title: "7x4min", type: "LONG_INTERVALS", reps: 7, note: "SHORT/LONG gate" },
];

const ALL_MODELS: [string, ChatOpenAI][] = [
  ["mini", gptMiniModel],
  ["gpt-4.1", gptStrongModel],
  ["o4-mini", o4ReasoningModel],
];
// MODELS=mini (or mini,gpt-4.1) limits the run — e.g. a cheap mini-only re-check.
const MODELS = process.env.MODELS
  ? ALL_MODELS.filter(([n]) => process.env.MODELS!.split(",").includes(n))
  : ALL_MODELS;

function wrap(a: number[] | null | undefined) {
  return Array.isArray(a) ? { data: a } : undefined;
}
function toStreamSet(s: Record<string, number[] | null>): StreamSet {
  return {
    time: wrap(s.time),
    distance: wrap(s.distance),
    heartrate: wrap(s.heartrate),
    velocity_smooth: wrap(s.velocity),
    moving: wrap(s.moving),
    altitude: wrap(s.altitude),
    cadence: wrap(s.cadence),
    watts: wrap(s.watts),
  } as unknown as StreamSet;
}
function countReps(structure: any): number {
  if (!Array.isArray(structure)) return 0;
  let n = 0;
  for (const set of structure) {
    const stepReps = (set.steps ?? []).reduce((a: number, st: any) => a + (st.reps ?? 1), 0);
    n += (set.set_reps ?? 1) * stepReps;
  }
  return n;
}

interface Cell {
  type: string | null;
  reps: number;
  typeOk: boolean;
  repsOk: boolean;
  ms: number;
  err?: string;
}

async function main() {
  const results: Record<number, Record<string, Cell>> = {};
  for (const fx of FIXTURES) {
    const dump = JSON.parse(readFileSync(join(DUMP_DIR, `activity-${fx.id}.json`), "utf8"));
    const act = dump.db.activity;
    const streams = toStreamSet(dump.pipeline.streams);
    const pred = dump.intervalsIcuRaw
      ? { subType: dump.intervalsIcuRaw.activity?.sub_type ?? null, intervals: dump.intervalsIcuRaw.intervals ?? [] }
      : null;
    results[fx.id] = {};
    for (const [name, model] of MODELS) {
      const t0 = Date.now();
      try {
        const res = await invokeActivityAnalysisAgent(
          streams,
          act.title ?? "",
          act.description ?? "",
          act.totalElevationGain ?? 0,
          act.sportType ?? "Run",
          pred,
          dump.pipeline?.laps ?? [],
          model,
        );
        const type = res?.training_type ?? null;
        const reps = countReps(res?.structure);
        results[fx.id][name] = {
          type,
          reps,
          typeOk: type === fx.type,
          repsOk: reps === fx.reps,
          ms: Date.now() - t0,
        };
      } catch (e) {
        results[fx.id][name] = {
          type: null,
          reps: 0,
          typeOk: false,
          repsOk: false,
          ms: Date.now() - t0,
          err: e instanceof Error ? e.message : String(e),
        };
      }
      const c = results[fx.id][name];
      console.log(
        `${String(fx.id).padEnd(4)} ${name.padEnd(8)} type=${String(c.type).padEnd(16)}${c.typeOk ? "✓" : "✗"} reps=${c.reps}/${fx.reps}${c.repsOk ? "✓" : "✗"} ${c.ms}ms${c.err ? ` ERR:${c.err.slice(0, 60)}` : ""}`,
      );
      await sleep(400);
    }
  }

  // summary
  console.log("\n=== SUMMARY (correct / total) ===");
  for (const [name] of MODELS) {
    let typeOk = 0;
    let repsOk = 0;
    let totMs = 0;
    for (const fx of FIXTURES) {
      const c = results[fx.id][name];
      if (c.typeOk) typeOk++;
      if (c.repsOk) repsOk++;
      totMs += c.ms;
    }
    console.log(
      `${name.padEnd(8)} classification ${typeOk}/${FIXTURES.length}  structure-reps ${repsOk}/${FIXTURES.length}  avg ${Math.round(totMs / FIXTURES.length)}ms`,
    );
  }

  // per-fixture rep matrix
  console.log("\n=== rep count by model (expected) ===");
  console.log(`fixture            exp  ${MODELS.map(([n]) => n.padEnd(8)).join("")}`);
  for (const fx of FIXTURES) {
    const cells = MODELS.map(([n]) => {
      const c = results[fx.id][n];
      return `${c.reps}${c.repsOk ? "✓" : "✗"}`.padEnd(8);
    }).join("");
    console.log(`${(`${fx.id} ${fx.title}`).padEnd(19)}${String(fx.reps).padEnd(5)}${cells}  ${fx.note ?? ""}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ab] fatal:", e);
    process.exit(1);
  });
