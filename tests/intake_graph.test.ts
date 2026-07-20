import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import * as intakeAgent from "../src/agent/planning/intake/intake_agent";
import { buildIntakeGraph, resetIntakeThread } from "../src/agent/planning/intake/intake_graph";

// Drives the REAL compiled intake graph (real PostgresSaver checkpointer, real
// ToolNode + state reducers). The single LLM seam — invokeIntakeModel — is
// scripted; no live OpenAI calls.

let callId = 0;
const aiToolCall = (name: string, args: Record<string, unknown>) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `call_${++callId}`, type: "tool_call" }],
  });
const aiText = (text: string) => new AIMessage({ content: text });

let script: AIMessage[] = [];

describe("intake graph — draft merging and finalize", () => {
  const threadId = `plan-intake:${randomUUID()}`;
  const config = { configurable: { thread_id: threadId } };
  let modelSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    modelSpy = spyOn(intakeAgent, "invokeIntakeModel").mockImplementation(async () => {
      const next = script.shift();
      if (!next) throw new Error("intake model script exhausted");
      return next;
    });
    await resetIntakeThread(threadId);
  });

  afterAll(async () => {
    modelSpy.mockRestore();
    await resetIntakeThread(threadId).catch(() => {});
  });

  it("merges an update_plan_draft tool round into the draft state", async () => {
    const graph = await buildIntakeGraph();
    script = [
      aiToolCall("update_plan_draft", { goalText: "sub-20 5k", daysPerWeek: 4 }),
      aiText("Nice goal. When would you like the plan to start?"),
    ];

    const result = await graph.invoke(
      { userId: "user-1", messages: [new HumanMessage("I want a sub-20 5k on 4 days a week")] },
      config,
    );

    expect(result.draft).toEqual({ goalText: "sub-20 5k", daysPerWeek: 4 });
    expect(result.ready).toBe(false);
    expect(result.athleteBrief).toBeNull();
    expect(result.messages[result.messages.length - 1].content).toBe(
      "Nice goal. When would you like the plan to start?",
    );
  });

  it("accumulates a later draft patch and finalize_intake flips ready + stores the brief", async () => {
    const graph = await buildIntakeGraph();
    const brief = "Calf strain in May, fully healed; prefers threshold work; club runner.";
    script = [
      aiToolCall("update_plan_draft", { preferredLongRunDay: 6 }),
      aiToolCall("finalize_intake", { athleteBrief: brief }),
      aiText("All set — you can start the plan builder."),
    ];

    const result = await graph.invoke(
      { userId: "user-1", messages: [new HumanMessage("Long runs on Sundays please")] },
      config,
    );

    expect(result.draft).toEqual({
      goalText: "sub-20 5k",
      daysPerWeek: 4,
      preferredLongRunDay: 6,
    });
    expect(result.ready).toBe(true);
    expect(result.athleteBrief).toBe(brief);
  });
});
