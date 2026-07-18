import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  isToolMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "bun:test";
import {
  MAX_TOOL_MESSAGE_CHARS,
  MAX_WINDOW_MESSAGES,
  TOOL_TRUNCATION_SUFFIX,
  windowMessages,
} from "../src/agent/training/message_window";

const human = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const aiWithToolCall = (id: string) =>
  new AIMessage({ content: "", tool_calls: [{ id, name: "get_x", args: {} }] });
const tool = (id: string, content = "result") =>
  new ToolMessage({ content, tool_call_id: id, name: "get_x" });

function firstType(messages: BaseMessage[]): string {
  return messages[0].getType();
}

describe("windowMessages", () => {
  it("passes through when under the cap", () => {
    const msgs = [human("hi"), ai("hello"), human("again"), ai("yo")];
    const out = windowMessages(msgs);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.getType())).toEqual(["human", "ai", "human", "ai"]);
  });

  it("caps the window to at most MAX_WINDOW_MESSAGES", () => {
    const msgs: BaseMessage[] = [];
    // Many small human/ai turns; well over the cap.
    for (let i = 0; i < MAX_WINDOW_MESSAGES * 2; i++) {
      msgs.push(i % 2 === 0 ? human(`q${i}`) : ai(`a${i}`));
    }
    const out = windowMessages(msgs);
    expect(out.length).toBeLessThanOrEqual(MAX_WINDOW_MESSAGES);
    expect(firstType(out)).toBe("human");
  });

  it("cuts at a human boundary: no orphaned ToolMessage at window start", () => {
    // Build turns each: human, ai-with-tool-call, tool, ai(final). 4 msgs/turn.
    const msgs: BaseMessage[] = [];
    const turns = MAX_WINDOW_MESSAGES; // 40 turns -> 160 messages
    for (let i = 0; i < turns; i++) {
      msgs.push(human(`q${i}`));
      msgs.push(aiWithToolCall(`call-${i}`));
      msgs.push(tool(`call-${i}`));
      msgs.push(ai(`a${i}`));
    }
    const out = windowMessages(msgs);
    expect(out.length).toBeLessThanOrEqual(MAX_WINDOW_MESSAGES);
    // Must start on a human, never mid tool-exchange.
    expect(firstType(out)).toBe("human");
    expect(isToolMessage(out[0])).toBe(false);
    // Every ToolMessage in the window is preceded somewhere by its AIMessage
    // carrying the matching tool_call id (never orphaned at the boundary).
    const seenToolCallIds = new Set<string>();
    for (const m of out) {
      if (m.getType() === "ai") {
        for (const tc of (m as AIMessage).tool_calls ?? []) if (tc.id) seenToolCallIds.add(tc.id);
      }
      if (isToolMessage(m)) {
        expect(seenToolCallIds.has(m.tool_call_id)).toBe(true);
      }
    }
  });

  it("always includes the full latest human turn even when it alone exceeds the cap", () => {
    const msgs: BaseMessage[] = [];
    // Older filler turns.
    for (let i = 0; i < 10; i++) msgs.push(human(`old${i}`), ai(`oldA${i}`));
    // One giant latest turn: human + many tool exchanges, no human in between.
    const latestHumanIndex = msgs.length;
    msgs.push(human("giant question"));
    for (let i = 0; i < MAX_WINDOW_MESSAGES + 5; i++) {
      msgs.push(aiWithToolCall(`g-${i}`), tool(`g-${i}`));
    }
    msgs.push(ai("final giant answer"));

    const out = windowMessages(msgs);
    // Exceeds the cap because the latest turn does.
    expect(out.length).toBeGreaterThan(MAX_WINDOW_MESSAGES);
    // Starts exactly at the latest human, and contains everything after it.
    expect(firstType(out)).toBe("human");
    expect((out[0] as HumanMessage).content).toBe("giant question");
    expect(out.length).toBe(msgs.length - latestHumanIndex);
  });

  it("truncates an oversized ToolMessage in the copy without mutating the original", () => {
    const huge = "x".repeat(MAX_TOOL_MESSAGE_CHARS + 500);
    const original = tool("call-1", huge);
    const msgs = [human("q"), aiWithToolCall("call-1"), original, ai("a")];

    const out = windowMessages(msgs);
    const windowedTool = out.find((m) => isToolMessage(m)) as ToolMessage;

    expect(windowedTool.content).not.toBe(huge);
    expect((windowedTool.content as string).endsWith(TOOL_TRUNCATION_SUFFIX)).toBe(true);
    expect((windowedTool.content as string).length).toBe(
      MAX_TOOL_MESSAGE_CHARS + TOOL_TRUNCATION_SUFFIX.length,
    );
    // Original object is untouched.
    expect(original.content).toBe(huge);
    expect(windowedTool).not.toBe(original);
  });

  it("leaves an under-threshold ToolMessage instance untouched", () => {
    const original = tool("call-1", "small result");
    const msgs = [human("q"), aiWithToolCall("call-1"), original, ai("a")];
    const out = windowMessages(msgs);
    expect(out.find((m) => isToolMessage(m))).toBe(original);
  });
});
