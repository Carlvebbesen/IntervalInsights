import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import type { PlanMacroWeek } from "../src/agent/planning/plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "../src/agent/planning/plan_builder_state";
import { intakeBriefBlock, invokeProposeMacroAgent } from "../src/agent/planning/plan_macro_agent";
import { invokeGenerateSessionsAgent } from "../src/agent/planning/plan_sessions_agent";

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

const BRIEF =
  "Returning from a calf strain in May; prefers threshold work over VO2; motivated by a club relay in autumn.";

const HEADER = "### ATHLETE INTERVIEW NOTES (from the intake conversation)";

describe("intakeBriefBlock", () => {
  it("renders an ATHLETE INTERVIEW NOTES block with the text when present", () => {
    const block = intakeBriefBlock(BRIEF);
    expect(block).toContain(HEADER);
    expect(block).toContain(BRIEF);
  });

  it("renders nothing when null, undefined, or blank", () => {
    expect(intakeBriefBlock(null)).toBe("");
    expect(intakeBriefBlock(undefined)).toBe("");
    expect(intakeBriefBlock("   ")).toBe("");
  });
});

describe("plan-builder prompts wire in the intake brief", () => {
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function capturePrompt() {
    const prompts: string[] = [];
    spies.push(
      spyOn(model, "invokeStructured").mockImplementation((async (
        _schema,
        prompt: string,
      ) => {
        prompts.push(prompt);
        return null;
      }) as typeof model.invokeStructured),
    );
    return prompts;
  }

  it("macro prompt includes the brief when intakeBriefText is set, omits it when absent", async () => {
    const withBrief = capturePrompt();
    const input: PlanBuilderInput = {
      startDate: "2026-01-05",
      endDate: "2026-01-25",
      intakeBriefText: BRIEF,
    };
    await invokeProposeMacroAgent(ctx, input, []);
    expect(withBrief[0]).toContain(HEADER);
    expect(withBrief[0]).toContain(BRIEF);

    for (const s of spies.splice(0)) s.mockRestore();
    const without = capturePrompt();
    await invokeProposeMacroAgent(ctx, { ...input, intakeBriefText: null }, []);
    expect(without[0]).not.toContain("ATHLETE INTERVIEW NOTES");
  });

  it("sessions prompt includes the brief when intakeBriefText is set, omits it when absent", async () => {
    const withBrief = capturePrompt();
    await invokeGenerateSessionsAgent(ctx, [macroWeek], [], null, [], BRIEF);
    expect(withBrief[0]).toContain(HEADER);
    expect(withBrief[0]).toContain(BRIEF);

    for (const s of spies.splice(0)) s.mockRestore();
    const without = capturePrompt();
    await invokeGenerateSessionsAgent(ctx, [macroWeek], [], null, []);
    expect(without[0]).not.toContain("ATHLETE INTERVIEW NOTES");
  });
});
