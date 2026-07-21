import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import { constraintsBlock, invokeProposeMacroAgent } from "../src/agent/planning/plan_macro_agent";
import { invokeGenerateSessionsAgent } from "../src/agent/planning/plan_sessions_agent";
import type { PlanMacroWeek } from "../src/agent/planning/plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "../src/agent/planning/plan_builder_state";

const ctx: AthleteContext = {
  athleteName: "Tester",
  maxHeartRate: 190,
  intervalsConnected: false,
  race: null,
  recentWeeks: [],
  fitness: null,
  raceAbility: null,
  baselineVolume: null,
  activeHealthEvents: [],
  workoutVocabulary: { types: [], hasStructuredIntervalHistory: false, structures: [] },
};

const macroWeek: PlanMacroWeek = {
  weekIndex: 1,
  startDate: "2026-01-05",
  phase: "base",
  targetDistanceMeters: 30000,
  keySessions: ["Long run"],
};

const CONSTRAINTS = "Club long run every Saturday; no running Fridays";

describe("constraintsBlock", () => {
  it("renders a SCHEDULING CONSTRAINTS block with the text when present", () => {
    const block = constraintsBlock(CONSTRAINTS);
    expect(block).toContain("SCHEDULING CONSTRAINTS (respect these)");
    expect(block).toContain(CONSTRAINTS);
  });

  it("renders nothing when null, undefined, or blank", () => {
    expect(constraintsBlock(null)).toBe("");
    expect(constraintsBlock(undefined)).toBe("");
    expect(constraintsBlock("   ")).toBe("");
  });
});

describe("plan-builder prompts wire in scheduling constraints", () => {
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function capturePrompt() {
    const prompts: string[] = [];
    spies.push(
      spyOn(model, "invokeStructured").mockImplementation(
        (async (_schema, prompt: string) => {
          prompts.push(prompt);
          return null;
        }) as typeof model.invokeStructured,
      ),
    );
    return prompts;
  }

  it("macro prompt includes the constraints block when constraintsText is set, omits it when null", async () => {
    const withConstraints = capturePrompt();
    const input: PlanBuilderInput = {
      startDate: "2026-01-05",
      endDate: "2026-01-25",
      constraintsText: CONSTRAINTS,
    };
    await invokeProposeMacroAgent(ctx, input, []);
    expect(withConstraints[0]).toContain("SCHEDULING CONSTRAINTS (respect these)");
    expect(withConstraints[0]).toContain(CONSTRAINTS);

    for (const s of spies.splice(0)) s.mockRestore();
    const without = capturePrompt();
    await invokeProposeMacroAgent(ctx, { ...input, constraintsText: null }, []);
    expect(without[0]).not.toContain("SCHEDULING CONSTRAINTS");
  });

  // The macro must not promise quality the sessions layer's qualityCap denies
  // (base weeks allow 1 quality session; promising a tempo AND an interval set
  // is an undeliverable keySessions list the athlete will notice).
  it("macro prompt caps promised key sessions to what each phase can deliver", async () => {
    const prompts = capturePrompt();
    await invokeProposeMacroAgent(
      ctx,
      { startDate: "2026-01-05", endDate: "2026-01-25" },
      [],
    );
    expect(prompts[0]).toContain("at most ONE quality key session");
    expect(prompts[0]).toContain("build and peak weeks may list");
  });

  it("sessions prompt includes the constraints block when constraintsText is set, omits it when null", async () => {
    const withConstraints = capturePrompt();
    await invokeGenerateSessionsAgent(ctx, [macroWeek], [], CONSTRAINTS);
    expect(withConstraints[0]).toContain("SCHEDULING CONSTRAINTS (respect these)");
    expect(withConstraints[0]).toContain(CONSTRAINTS);

    for (const s of spies.splice(0)) s.mockRestore();
    const without = capturePrompt();
    await invokeGenerateSessionsAgent(ctx, [macroWeek], [], null);
    expect(without[0]).not.toContain("SCHEDULING CONSTRAINTS");
  });
});
