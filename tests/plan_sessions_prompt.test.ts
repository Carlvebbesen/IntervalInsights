import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import { generateSessions } from "../src/agent/planning/nodes/generate_sessions";
import type {
  GenerateSessionsOutput,
  PlanMacroWeek,
} from "../src/agent/planning/plan_builder_schemas";
import type { AthleteContext, PlanBuilderState } from "../src/agent/planning/plan_builder_state";
import * as sessionsAgent from "../src/agent/planning/plan_sessions_agent";
import { invokeGenerateSessionsAgent } from "../src/agent/planning/plan_sessions_agent";
import type { WorkoutStructureSet } from "../src/schemas/agent_schemas";

// The sessions prompt must carry the athlete's real interval repertoire and,
// past the first ≤4-week batch, the quality sessions already planned — the two
// inputs that let the model progress a small rotation of proven shapes instead
// of inventing a new one per week.

const ctx = (over: Partial<AthleteContext> = {}): AthleteContext => ({
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
  ...over,
});

const week = (weekIndex: number, startDate: string): PlanMacroWeek => ({
  weekIndex,
  startDate,
  phase: "build",
  targetDistanceMeters: 40000,
  keySessions: ["Intervals"],
});

describe("sessions prompt content", () => {
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function capturePrompt() {
    const prompts: string[] = [];
    spies.push(
      spyOn(model, "invokeStructured").mockImplementation((async (_schema, prompt: string) => {
        prompts.push(prompt);
        return null;
      }) as typeof model.invokeStructured),
    );
    return prompts;
  }

  it("renders the proven interval repertoire, omitted when the athlete has none", async () => {
    const withRepertoire = capturePrompt();
    await invokeGenerateSessionsAgent(
      ctx({
        workoutVocabulary: {
          types: ["EASY", "LONG_INTERVALS"],
          hasStructuredIntervalHistory: true,
          structures: [
            { name: "(n)x 1000m", activityCount: 11, lastDoneAt: "2026-06-25" },
            { name: "Tempo 20min", activityCount: 4, lastDoneAt: null },
          ],
        },
      }),
      [week(1, "2026-01-05")],
      [],
    );
    expect(withRepertoire[0]).toContain("Proven interval repertoire");
    expect(withRepertoire[0]).toContain("(n)x 1000m (done 11x, last 2026-06-25)");
    expect(withRepertoire[0]).toContain("Tempo 20min (done 4x)");

    for (const s of spies.splice(0)) s.mockRestore();
    const without = capturePrompt();
    await invokeGenerateSessionsAgent(ctx(), [week(1, "2026-01-05")], []);
    expect(without[0]).not.toContain("Proven interval repertoire");
  });

  it("renders the prior-sessions block on a later batch, omitted on the first", async () => {
    const later = capturePrompt();
    await invokeGenerateSessionsAgent(ctx(), [week(5, "2026-02-02")], [], null, [
      "Week 1: 5x1000m",
      "Week 4: Tempo 25 min; 6x1000m",
    ]);
    expect(later[0]).toContain("### SESSIONS ALREADY PLANNED");
    expect(later[0]).toContain("- Week 1: 5x1000m");
    expect(later[0]).toContain("- Week 4: Tempo 25 min; 6x1000m");

    for (const s of spies.splice(0)) s.mockRestore();
    const first = capturePrompt();
    await invokeGenerateSessionsAgent(ctx(), [week(1, "2026-01-05")], [], null, []);
    expect(first[0]).not.toContain("### SESSIONS ALREADY PLANNED");
  });

  it("carries the interval-continuity and strides rules", async () => {
    const prompts = capturePrompt();
    await invokeGenerateSessionsAgent(ctx(), [week(1, "2026-01-05")], []);
    expect(prompts[0]).toContain("Repeat and progress a small rotation of interval shapes");
    expect(prompts[0]).toContain("4x1000m → 5x1000m → 6x1000m");
    expect(prompts[0]).toContain("a second\n    rep-interval session is allowed");
    expect(prompts[0]).toContain("NEVER as a standalone SPRINTS");
    expect(prompts[0]).toContain("finish with 6 x 100 m relaxed strides");
  });

  it("carries the threshold-dosing rules", async () => {
    const prompts = capturePrompt();
    await invokeGenerateSessionsAgent(ctx(), [week(1, "2026-01-05")], []);
    expect(prompts[0]).toContain("THRESHOLD DOSING");
    expect(prompts[0]).toContain("~15–20\n    minutes of work at threshold");
    expect(prompts[0]).toContain("past 30 minutes");
    expect(prompts[0]).toContain("45 s on / 15 s off");
    expect(prompts[0]).toContain("(n) x 400 m with 15–25 reps");
    expect(prompts[0]).toContain("Progress the dose (reps/duration)");
  });
});

describe("generateSessions passes prior batches' quality sessions to later batches", () => {
  const structure: WorkoutStructureSet[] = [
    {
      set_reps: 1,
      set_recovery: null,
      steps: [
        {
          reps: 5,
          work_type: "DISTANCE",
          work_value: 1000,
          recovery_type: "TIME",
          recovery_value: 90,
          target_pace: null,
        },
      ],
    },
  ];

  const mondays = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02", "2026-02-09"];

  const output = (weeks: PlanMacroWeek[]): GenerateSessionsOutput => ({
    weeks: weeks.map((w) => ({
      weekIndex: w.weekIndex,
      sessions: [
        {
          date: w.startDate,
          sessionType: "LONG_INTERVALS" as const,
          title: `${4 + w.weekIndex}x1000m`,
          structure,
        },
        ...Array.from({ length: 3 }, () => ({
          date: w.startDate,
          sessionType: "EASY" as const,
          title: "Easy run",
        })),
      ],
    })),
  });

  it("second batch receives the first batch's structured-session titles per week", async () => {
    const priorArgs: string[][] = [];
    const spy = spyOn(sessionsAgent, "invokeGenerateSessionsAgent").mockImplementation((async (
      _ctx: unknown,
      weeks: PlanMacroWeek[],
      _feedback: unknown,
      _constraints: unknown,
      priorQualitySessions: string[] = [],
    ) => {
      priorArgs.push([...priorQualitySessions]);
      return output(weeks);
    }) as typeof sessionsAgent.invokeGenerateSessionsAgent);

    const state = {
      userId: "test-user",
      input: { startDate: mondays[0], endDate: "2026-02-15", daysPerWeek: 5 },
      macro: {
        name: "Six weeks",
        rationale: "build",
        weeks: mondays.map((startDate, i) => week(i + 1, startDate)),
      },
      athleteContext: ctx(),
      sessionsFeedback: [],
      sessionsByWeek: [],
    } as unknown as PlanBuilderState;

    const result = await generateSessions(state);

    expect(priorArgs).toHaveLength(2);
    expect(priorArgs[0]).toEqual([]);
    expect(priorArgs[1]).toEqual([
      "Week 1: 5x1000m",
      "Week 2: 6x1000m",
      "Week 3: 7x1000m",
      "Week 4: 8x1000m",
    ]);
    expect(result.sessionsByWeek).toHaveLength(6);
    spy.mockRestore();
  });
});
