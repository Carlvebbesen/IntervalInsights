import { sleep } from "bun";
import { readdirSync } from "fs";
import { invokeActivityAnalysisAgent } from "../src/agent/initial_analysis_agent";
import { buildLapEvidenceBlock } from "../src/agent/lap_evidence";

/**
 * Full-corpus classifier audit. Runs the REAL classifier (with the lap-evidence
 * hint) on every activity-*.json dump, then flags anomalies: committed-vs-classified
 * disagreement, title-implies-intervals-but-got-EASY, lap-evidence-fired-but-got-EASY.
 * Read-only; no DB. Run: bun run scripts/audit_classify.ts
 */

const DUMP =
  process.env.DUMP ??
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";
const DELAY_MS = Number(process.env.DELAY_MS ?? 700);

const INTERVAL_TYPES = new Set([
  "SHORT_INTERVALS",
  "LONG_INTERVALS",
  "SPRINTS",
  "HILL_SPRINTS",
  "TEMPO",
  "FARTLEK",
  "PROGRESSIVE_LONG",
]);

function toStreamSet(s: any) {
  const wrap = (arr: any) => (Array.isArray(arr) ? { data: arr } : undefined);
  return {
    time: wrap(s?.time) ?? { data: [] },
    velocity_smooth: wrap(s?.velocity),
    heartrate: wrap(s?.heartrate),
    distance: wrap(s?.distance),
    moving: wrap(s?.moving),
  } as any;
}

function titleImpliesIntervals(title: string): boolean {
  const t = title.toLowerCase();
  if (/\b\d+\s*[x×]\s*\(?\d/.test(t)) return true; // 8x1000, 4x(3,2,1
  if (/\d+\s*\/\s*\d+/.test(t)) return true; // 45/15
  if (/\b(intervall|interval|tempo|terskel|threshold|sprint|bakke|hill|drag)\b/.test(t)) return true;
  return false;
}

function repsInStructure(structure: any): number {
  if (!Array.isArray(structure)) return 0;
  let n = 0;
  for (const set of structure) {
    const stepReps = (set.steps ?? []).reduce((a: number, st: any) => a + (st.reps ?? 1), 0);
    n += (set.set_reps ?? 1) * stepReps;
  }
  return n;
}

async function main() {
  const files = readdirSync(DUMP)
    .filter((f) => /^activity-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  const flags: string[] = [];
  let i = 0;
  for (const f of files) {
    const d = await Bun.file(`${DUMP}/${f}`).json();
    const a = d.db.activity;
    const laps = d.pipeline?.laps ?? [];
    const time = d.pipeline?.streams?.time ?? [];
    const streams = toStreamSet(d.pipeline?.streams);
    const commit = a.trainingType ?? null;
    const lapEvid = buildLapEvidenceBlock(laps, time);
    const lapReps = lapEvid ? Number(lapEvid.match(/\*\*(\d+) work reps\*\*/)?.[1] ?? 0) : 0;

    let got = "ERR";
    let conf: number | string = "-";
    let reps = 0;
    let reason = "";
    try {
      const out = await invokeActivityAnalysisAgent(
        streams,
        a.title,
        a.description || "-",
        a.totalElevationGain ?? 0,
        a.sportType,
        null,
        laps,
      );
      got = out?.training_type ?? "NULL";
      conf = out?.confidence_score ?? "-";
      reps = repsInStructure(out?.structure);
      reason = String(out?.classification_reasoning ?? "").slice(0, 120);
    } catch (e) {
      reason = `EXC ${e instanceof Error ? e.message : String(e)}`;
    }

    const titleInt = titleImpliesIntervals(String(a.title || ""));
    const gotInterval = INTERVAL_TYPES.has(got);
    const marks: string[] = [];
    if (commit && commit !== got) marks.push(`COMMIT≠ (${commit})`);
    if (titleInt && got === "EASY") marks.push("TITLE-INT→EASY");
    if (lapEvid && got === "EASY") marks.push(`LAPEVID(${lapReps})→EASY`);
    if (lapEvid && gotInterval && reps > 0 && Math.abs(reps - lapReps) > 1)
      marks.push(`REPΔ lap=${lapReps} struct=${reps}`);

    const tag = marks.length ? `  ⚠️ ${marks.join(" ")}` : "";
    if (marks.length) flags.push(`${a.id} "${String(a.title).slice(0, 26)}" → ${got}${tag}`);

    console.log(
      `${String(a.id).padStart(4)} ${(d.source?.kind || "-").padEnd(9)} laps=${String(laps.length).padStart(2)} lapEvid=${lapEvid ? lapReps : "-"} commit=${String(commit || "-").padEnd(15)} got=${String(got).padEnd(16)} conf=${conf} reps=${reps} "${String(a.title).slice(0, 26)}"${tag}`,
    );
    if (process.env.REASON) console.log(`       ${reason}`);
    i++;
    if (i < files.length) await sleep(DELAY_MS);
  }

  console.log(`\n===== FLAGS (${flags.length}) =====`);
  for (const fl of flags) console.log(fl);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
