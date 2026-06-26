import { sleep } from "bun";
import { invokeActivityAnalysisAgent } from "../src/agent/initial_analysis_agent";

/**
 * Cheap classifier-only validation harness. Calls the REAL classifier
 * (invokeActivityAnalysisAgent) directly on dumped streams + the user's true DB
 * title/description — NO graph, NO enrich polling, NO DB mutation. Lets us iterate
 * the classification prompt fast and cheap (one gpt-4o-mini call per fixture).
 *
 * intervalsIcuPrediction is passed null to isolate the title+prompt effect
 * (production additionally feeds the intervals.icu block hint).
 *
 * Run: cd interval-insights/interval-insights && bun run scripts/classify_check.ts
 */

const DUMP =
  process.env.DUMP ??
  "/Users/carlvaldemarebbesen/Development/intervals/knowledge/knowledge/sources/activity-dumps";

const EXPECTED: Record<number, string> = {
  503: "LONG_INTERVALS",
  504: "SHORT_INTERVALS",
  509: "SHORT_INTERVALS",
  608: "SHORT_INTERVALS",
  615: "LONG_INTERVALS",
  47: "SHORT_INTERVALS",
  48: "EASY",
  50: "EASY",
  505: "LONG_INTERVALS",
  508: "LONG_INTERVALS",
  510: "LONG_INTERVALS",
  507: "LONG_INTERVALS",
  626: "LONG_INTERVALS",
  625: "SHORT_INTERVALS",
};

const FIXTURES = process.env.FIXTURES
  ? process.env.FIXTURES.split(",").map(Number)
  : Object.keys(EXPECTED).map(Number);
const DELAY_MS = Number(process.env.DELAY_MS ?? 800);

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

async function main() {
  let pass = 0;
  for (let i = 0; i < FIXTURES.length; i++) {
    const id = FIXTURES[i];
    const d = await Bun.file(`${DUMP}/activity-${id}.json`).json();
    const a = d.db.activity;
    const out = await invokeActivityAnalysisAgent(
      toStreamSet(d.pipeline?.streams),
      a.title,
      a.description || "-",
      a.totalElevationGain ?? 0,
      a.sportType,
      null,
      d.pipeline?.laps ?? [],
    );
    const got = out?.training_type ?? "NULL";
    const expected = EXPECTED[id] ?? "?";
    const ok = got === expected;
    if (ok) pass++;
    console.log(
      `[classify] ${id} "${String(a.title).slice(0, 24)}" exp=${expected} got=${got} ${ok ? "OK" : "WRONG"} conf=${out?.confidence_score ?? "-"}`,
    );
    if (out?.classification_reasoning) {
      console.log(`           reason: ${String(out.classification_reasoning).slice(0, 160)}`);
    }
    if (i < FIXTURES.length - 1) await sleep(DELAY_MS);
  }
  console.log(`[classify] ${pass}/${FIXTURES.length} correct`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[classify] fatal:", e);
    process.exit(1);
  });
