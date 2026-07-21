// Manual E2E harness for the plan-builder agents: drives the real nodes
// (proposeMacro / feedback loop / generateSessions) with a synthetic
// AthleteContext from a persona file — real LLM calls, no DB, no persistence.
//
// Usage (from the repo root, .env provides OPENAI_API_KEY):
//   bun scripts/plan_builder_harness.ts propose  <persona.json> <state.json>
//   bun scripts/plan_builder_harness.ts adjust   <state.json> "<macro feedback>"
//   bun scripts/plan_builder_harness.ts sessions <state.json>
//   bun scripts/plan_builder_harness.ts adjust-sessions <state.json> "<sessions feedback>"
//   bun scripts/plan_builder_harness.ts show     <state.json>

process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";

import {
  applyPlanInputPatch,
  describePlanInputPatch,
  extractPlanInputPatch,
} from "../src/agent/planning/feedback_intent";
import { generateSessions } from "../src/agent/planning/nodes/generate_sessions";
import { proposeMacro } from "../src/agent/planning/nodes/propose_macro";
import type { PlanNotice } from "../src/agent/planning/plan_builder_schemas";
import type {
  AthleteContext,
  PlanBuilderInput,
  PlanBuilderState,
} from "../src/agent/planning/plan_builder_state";

type HarnessState = {
  persona: string;
  input: PlanBuilderInput;
  athleteContext: AthleteContext;
  macroFeedback: string[];
  sessionsFeedback: string[];
  macro: PlanBuilderState["macro"];
  sessionsByWeek: PlanBuilderState["sessionsByWeek"];
  feedbackNotices: PlanNotice[];
  guardNotices: PlanNotice[];
  timingsMs: Record<string, number>;
};

function toGraphState(s: HarnessState): PlanBuilderState {
  return {
    userId: `harness:${s.persona}`,
    input: s.input,
    athleteContext: s.athleteContext,
    macro: s.macro,
    macroFeedback: s.macroFeedback,
    sessionsByWeek: s.sessionsByWeek,
    sessionsFeedback: s.sessionsFeedback,
    feedbackNotices: s.feedbackNotices,
    guardNotices: s.guardNotices,
    contextNotices: [],
    action: null,
    persistedPlanId: null,
  };
}

async function load(path: string): Promise<HarnessState> {
  return JSON.parse(await Bun.file(path).text());
}

async function save(path: string, s: HarnessState): Promise<void> {
  await Bun.write(path, JSON.stringify(s, null, 2));
}

function fmtKm(m: number): string {
  return `${(m / 1000).toFixed(1)}km`;
}

function printNotices(label: string, notices: PlanNotice[]): void {
  if (notices.length === 0) return;
  console.log(`\n--- ${label} ---`);
  for (const n of notices) console.log(`[${n.kind}/${n.code}] ${n.message}`);
}

function printMacro(s: HarnessState): void {
  if (!s.macro) {
    console.log("(no macro yet)");
    return;
  }
  console.log(`\n=== MACRO: ${s.macro.name} ===`);
  console.log(`Rationale: ${s.macro.rationale}`);
  for (const w of s.macro.weeks) {
    console.log(
      `W${String(w.weekIndex).padStart(2)} ${w.startDate} [${w.phase.padEnd(5)}] ${fmtKm(w.targetDistanceMeters).padStart(8)}  key: ${w.keySessions.join(", ") || "-"}${w.notes ? `\n    note: ${w.notes}` : ""}`,
    );
  }
  printNotices("feedback notices", s.feedbackNotices);
  printNotices("guard notices", s.guardNotices);
}

function printSessions(s: HarnessState): void {
  if (s.sessionsByWeek.length === 0) {
    console.log("(no sessions yet)");
    return;
  }
  console.log("\n=== SESSIONS ===");
  for (const w of s.sessionsByWeek) {
    const target = s.macro?.weeks.find((m) => m.weekIndex === w.weekIndex)?.targetDistanceMeters;
    console.log(`\nWeek ${w.weekIndex}${target != null ? ` (target ${fmtKm(target)})` : ""}`);
    for (const sess of w.sessions) {
      const structured = sess.structure && sess.structure.length > 0 ? " [structured]" : "";
      console.log(
        `  ${sess.date} ${sess.sessionType.padEnd(16)} ${sess.title}${structured}${sess.description ? ` — ${sess.description}` : ""}`,
      );
    }
  }
  printNotices("guard notices", s.guardNotices);
}

async function timed<T>(s: HarnessState, label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  s.timingsMs[label] = Math.round(performance.now() - t0);
  console.log(`\n[timing] ${label}: ${(s.timingsMs[label] / 1000).toFixed(1)}s`);
  return out;
}

const [cmd, arg1, arg2] = process.argv.slice(2);

switch (cmd) {
  case "propose": {
    const persona = JSON.parse(await Bun.file(arg1).text()) as {
      name: string;
      input: PlanBuilderInput;
      athleteContext: AthleteContext;
    };
    const s: HarnessState = {
      persona: persona.name,
      input: persona.input,
      athleteContext: persona.athleteContext,
      macroFeedback: [],
      sessionsFeedback: [],
      macro: null,
      sessionsByWeek: [],
      feedbackNotices: [],
      guardNotices: [],
      timingsMs: {},
    };
    const update = await timed(s, "propose", () => proposeMacro(toGraphState(s)));
    s.macro = update.macro ?? null;
    s.guardNotices = update.guardNotices ?? [];
    await save(arg2, s);
    printMacro(s);
    break;
  }
  case "adjust": {
    const s = await load(arg1);
    const feedback = arg2;
    if (!feedback) throw new Error("adjust requires feedback text");
    const round = s.macroFeedback.length;
    const patch = await timed(s, `intent-extract-${round}`, () =>
      extractPlanInputPatch(feedback, s.input, "macro"),
    );
    s.input = applyPlanInputPatch(s.input, patch);
    s.feedbackNotices = describePlanInputPatch(patch);
    s.macroFeedback = [...s.macroFeedback, feedback];
    console.log(`patched fields: ${Object.keys(patch).join(", ") || "(none — prose only)"}`);
    const update = await timed(s, `re-propose-${round}`, () => proposeMacro(toGraphState(s)));
    s.macro = update.macro ?? null;
    s.guardNotices = update.guardNotices ?? [];
    await save(arg1, s);
    printMacro(s);
    break;
  }
  case "sessions": {
    const s = await load(arg1);
    const update = await timed(s, `sessions-${s.sessionsFeedback.length}`, () =>
      generateSessions(toGraphState(s)),
    );
    s.sessionsByWeek = update.sessionsByWeek ?? [];
    s.guardNotices = update.guardNotices ?? [];
    await save(arg1, s);
    printSessions(s);
    break;
  }
  case "adjust-sessions": {
    const s = await load(arg1);
    const feedback = arg2;
    if (!feedback) throw new Error("adjust-sessions requires feedback text");
    const patch = await timed(s, "sessions-intent-extract", () =>
      extractPlanInputPatch(feedback, s.input, "sessions"),
    );
    s.input = applyPlanInputPatch(s.input, patch);
    s.feedbackNotices = describePlanInputPatch(patch);
    s.sessionsFeedback = [...s.sessionsFeedback, feedback];
    console.log(`patched fields: ${Object.keys(patch).join(", ") || "(none — prose only)"}`);
    const update = await timed(s, `sessions-${s.sessionsFeedback.length}`, () =>
      generateSessions(toGraphState(s)),
    );
    s.sessionsByWeek = update.sessionsByWeek ?? [];
    s.guardNotices = update.guardNotices ?? [];
    await save(arg1, s);
    printSessions(s);
    break;
  }
  case "show": {
    const s = await load(arg1);
    printMacro(s);
    printSessions(s);
    console.log(`\ntimings: ${JSON.stringify(s.timingsMs)}`);
    break;
  }
  default:
    console.log("commands: propose | adjust | sessions | adjust-sessions | show");
    process.exit(1);
}
