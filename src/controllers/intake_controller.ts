import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import type { Context } from "hono";
import { buildIntakeGraph, resetIntakeThread } from "../agent/planning/intake/intake_graph";
import type { IntakeDraft } from "../agent/planning/intake/intake_state";
import type { CoachCtx } from "../agent/training/tool_types";
import { AppError } from "../error";
import type { TGlobalEnv } from "../types/IRouters";
import { clearTurnActive, isTurnActive, markTurnActive } from "./active_turns";

const THREAD_PREFIX = "plan-intake:";

export interface IntakeTurnResult {
  threadId: string;
  reply: string;
  draft: IntakeDraft;
  ready: boolean;
  brief?: string;
}

type IntakeGraph = Awaited<ReturnType<typeof buildIntakeGraph>>;

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

// Same body for "unknown thread" and "someone else's thread" — an unknown
// thread has no checkpoint, so state.values.userId is undefined and fails
// identically, leaking nothing about thread existence.
async function assertThreadOwned(
  graph: IntakeGraph,
  threadId: string,
  userId: string,
): Promise<void> {
  const state = await graph.getState(threadConfig(threadId));
  if (state.values.userId !== userId) {
    throw new AppError(404, "No intake conversation for this thread");
  }
}

function replyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return "";
}

export async function runIntakeTurn(
  c: Context<TGlobalEnv>,
  body: { threadId?: string; message: string },
): Promise<IntakeTurnResult> {
  const db = c.env.db;
  const userId = c.get("userId");
  const graph = await buildIntakeGraph();

  const threadId = body.threadId ?? `${THREAD_PREFIX}${randomUUID()}`;
  if (body.threadId) await assertThreadOwned(graph, body.threadId, userId);

  if (isTurnActive(threadId)) {
    throw new AppError(409, "A reply is already in progress for this conversation.");
  }
  markTurnActive(threadId);
  try {
    const ctx: CoachCtx = {
      db,
      userId,
      stravaAccessToken: "",
      intervalsConnected: false,
      stravaLinked: false,
      userTime: new Date().toISOString(),
      logger: c.var.logger,
    };
    const result = await graph.invoke(
      { userId, messages: [new HumanMessage(body.message)] },
      { ...threadConfig(threadId), context: ctx as unknown as Record<string, unknown> },
    );

    const last = result.messages[result.messages.length - 1];
    return {
      threadId,
      reply: replyText(last?.content),
      draft: result.draft,
      ready: result.ready,
      ...(result.ready && result.athleteBrief ? { brief: result.athleteBrief } : {}),
    };
  } finally {
    clearTurnActive(threadId);
  }
}

export async function resetIntake(
  c: Context<TGlobalEnv>,
  threadId: string,
): Promise<{ success: true }> {
  const graph = await buildIntakeGraph();
  await assertThreadOwned(graph, threadId, c.get("userId"));
  await resetIntakeThread(threadId);
  return { success: true };
}
