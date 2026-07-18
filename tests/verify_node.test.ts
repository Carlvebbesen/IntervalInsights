import { AIMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as model from "../src/agent/model";
import type { TrainingState } from "../src/agent/training/graph_state";
import { verifyNode } from "../src/agent/training/nodes/verify_node";

function baseState(draft: AIMessage): TrainingState {
  return {
    messages: [new HumanMessage("how should I train?"), draft],
    verifyAttempts: 0,
    verifyFeedback: null,
    finalAnswer: null,
    verdict: null,
    blocked: false,
    pendingArtifacts: [],
  } as unknown as TrainingState;
}

afterEach(() => {
  spyOn(model, "invokeStructured").mockRestore();
});

describe("verifyNode regenerate branch", () => {
  it("emits a RemoveMessage targeting the rejected draft's id", async () => {
    spyOn(model, "invokeStructured").mockResolvedValue({
      pass: false,
      reason: "unsafe",
      feedback: "make it safer",
    });
    const draft = new AIMessage({ id: "draft-1", content: "risky answer" });

    const update = await verifyNode(baseState(draft));

    expect(update.verdict).toBe("regenerate");
    expect(update.verifyFeedback).toBe("make it safer");
    const removals = (update.messages ?? []).filter((m) => m instanceof RemoveMessage);
    expect(removals).toHaveLength(1);
    expect((removals[0] as RemoveMessage).id).toBe("draft-1");
  });

  it("skips removal (no crash) when the rejected draft has no id", async () => {
    spyOn(model, "invokeStructured").mockResolvedValue({
      pass: false,
      reason: "unsafe",
      feedback: "make it safer",
    });
    const draft = new AIMessage({ content: "risky answer" });

    const update = await verifyNode(baseState(draft));

    expect(update.verdict).toBe("regenerate");
    expect(update.messages).toBeUndefined();
  });

  it("pass branch is unchanged: no message removals", async () => {
    spyOn(model, "invokeStructured").mockResolvedValue({
      pass: true,
      reason: "fine",
      feedback: "",
    });
    const draft = new AIMessage({ id: "draft-2", content: "great answer" });

    const update = await verifyNode(baseState(draft));

    expect(update.verdict).toBe("pass");
    expect(update.finalAnswer).toBe("great answer");
    expect(update.messages).toBeUndefined();
  });
});
