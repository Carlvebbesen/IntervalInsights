import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  isAIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { SAFE_REFUSAL } from "../agent/training/prompts";
import type { CoachCtx } from "../agent/training/tool_types";
import { buildTrainingGraph } from "../agent/training/training_graph";
import { AppError } from "../error";
import * as chatRepo from "../repositories/chat_repository";
import * as userRepo from "../repositories/user_repository";
import type { ChatMessageStatus } from "../schema";
import type { CoachArtifact, CoachChatRequest } from "../schemas/api_schemas";
import type { IGlobalBindings, TStravaEnv } from "../types/IRouters";
import { clearTurnActive, isTurnActive, markTurnActive } from "./active_turns";

type Db = IGlobalBindings["db"];

const GRAPH_ERROR_CONTENT = "Sorry — I ran into an error answering that. Please try again.";

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

function buildUserTurn(body: CoachChatRequest, intervalsConnected: boolean): string {
  const lines = [`Athlete local time: ${body.userTime}`];
  if (body.weather) lines.push(`Weather: ${JSON.stringify(body.weather)}`);
  lines.push(
    `intervals.icu: ${intervalsConnected ? "connected" : "not connected"}`,
    "",
    body.message,
  );
  return lines.join("\n");
}

function* chunkText(text: string): Generator<string> {
  const parts = text.split(/(\s+)/);
  let buf = "";
  for (const part of parts) {
    buf += part;
    if (buf.length >= 24) {
      yield buf;
      buf = "";
    }
  }
  if (buf) yield buf;
}

async function persistAssistantOutcome(
  db: Db,
  conversationId: string,
  content: string,
  artifacts: CoachArtifact[] | null,
  status: ChatMessageStatus | null,
  log: CoachCtx["logger"],
): Promise<{ id: number; createdAt: Date } | null> {
  try {
    const row = await chatRepo.insertMessage(
      db,
      conversationId,
      "assistant",
      content,
      artifacts,
      status,
    );
    await chatRepo.touchConversation(db, conversationId);
    return row;
  } catch (err) {
    log.error({ err, status }, "coach: failed to persist assistant outcome");
    return null;
  }
}

async function repairDanglingToolCalls(
  graph: Awaited<ReturnType<typeof buildTrainingGraph>>,
  conversationId: string,
  log: CoachCtx["logger"],
): Promise<void> {
  const threadCfg = { configurable: { thread_id: conversationId } };
  try {
    const prior = await graph.getState(threadCfg);
    const messages = (prior?.values as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
    const last = messages[messages.length - 1];
    if (!last || !isAIMessage(last)) return;
    const toolCalls = (last as AIMessage).tool_calls ?? [];
    if (toolCalls.length === 0) return;
    const repairs = toolCalls
      .filter((tc) => tc.id)
      .map(
        (tc) =>
          new ToolMessage({
            tool_call_id: tc.id as string,
            content: "Tool run was interrupted before returning a result.",
          }),
      );
    if (repairs.length === 0) return;
    await graph.updateState(threadCfg, { messages: repairs }, "tools");
    log.warn({ conversationId, repaired: repairs.length }, "coach: repaired dangling tool_calls");
  } catch (err) {
    log.warn({ err }, "coach: thread repair check failed — continuing");
  }
}

export function streamCoachChat(c: Context<TStravaEnv>, body: CoachChatRequest): Response {
  const db = c.env.db;
  const userId = c.get("userId");
  const stravaAccessToken = c.get("stravaAccessToken");
  const log = c.var.logger;

  (c.env as { timeout?: (req: Request, seconds: number) => void }).timeout?.(c.req.raw, 0);

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    let clientGone = false;
    const safeWrite = async (event: string, data: string) => {
      if (clientGone) return;
      try {
        await stream.writeSSE({ event, data });
      } catch {
        clientGone = true;
        abort.abort();
      }
    };

    let ctx: CoachCtx;
    try {
      const user = await userRepo.findById(db, userId);
      ctx = {
        db,
        userId,
        stravaAccessToken,
        intervalsConnected: !!user?.intervalsAthleteId,
        stravaLinked: !!user?.stravaId,
        userTime: body.userTime,
        weather: body.weather,
        logger: log,
      };
    } catch (err) {
      log.error({ err }, "coach: failed to build context");
      await safeWrite("error", JSON.stringify({ error: "Failed to start." }));
      return;
    }

    let owned: boolean;
    try {
      owned = await chatRepo.ensureConversation(
        db,
        userId,
        body.conversationId,
        deriveTitle(body.message),
      );
    } catch (err) {
      log.error({ err }, "coach: conversation ownership check failed");
      await safeWrite("error", JSON.stringify({ error: "Failed to start." }));
      return;
    }
    if (!owned) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "conversationId belongs to another conversation." }),
      );
      return;
    }

    if (isTurnActive(body.conversationId)) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "A reply is already in progress for this conversation." }),
      );
      return;
    }
    markTurnActive(body.conversationId);

    try {
      try {
        await chatRepo.insertMessage(db, body.conversationId, "user", body.message);
      } catch (err) {
        log.error({ err }, "coach: failed to persist user message");
        await safeWrite("error", JSON.stringify({ error: "Failed to start." }));
        return;
      }

      const graph = await buildTrainingGraph();
      await repairDanglingToolCalls(graph, body.conversationId, log);

      const human = new HumanMessage(buildUserTurn(body, ctx.intervalsConnected));
      const input = {
        messages: [human],
        verifyAttempts: 0,
        verifyFeedback: null,
        finalAnswer: null,
        verdict: null,
        blocked: false,
        pendingArtifacts: null,
      };

      let finalAnswer = SAFE_REFUSAL;
      let artifacts: CoachArtifact[] = [];
      try {
        const events = await graph.stream(input, {
          configurable: { thread_id: body.conversationId },
          context: ctx as unknown as Record<string, unknown>,
          streamMode: ["custom", "values"],
          signal: abort.signal,
        });
        for await (const event of events) {
          const [mode, data] = event as [string, unknown];
          if (mode === "custom") {
            await safeWrite("status", JSON.stringify(data));
          } else if (mode === "values") {
            const v = data as { finalAnswer?: string | null; pendingArtifacts?: CoachArtifact[] };
            if (v.finalAnswer) finalAnswer = v.finalAnswer;
            if (v.pendingArtifacts) artifacts = v.pendingArtifacts;
          }
        }
      } catch (err) {
        if (abort.signal.aborted) {
          log.info("coach: client disconnected — graph aborted");
          await persistAssistantOutcome(db, body.conversationId, "", null, "interrupted", log);
          return;
        }
        log.error({ err }, "coach: graph run failed");
        await persistAssistantOutcome(
          db,
          body.conversationId,
          GRAPH_ERROR_CONTENT,
          null,
          "error",
          log,
        );
        await safeWrite(
          "error",
          JSON.stringify({ error: "The coach hit an error answering that." }),
        );
        return;
      }

      const row = await persistAssistantOutcome(
        db,
        body.conversationId,
        finalAnswer,
        artifacts,
        null,
        log,
      );
      if (!row) {
        await safeWrite("error", JSON.stringify({ error: "Failed to save the answer." }));
        return;
      }
      const messageId: number | null = row.id;
      const messageCreatedAt: string | null = row.createdAt.toISOString();

      for (const piece of chunkText(finalAnswer)) {
        await safeWrite("token", JSON.stringify({ text: piece }));
      }
      for (const artifact of artifacts) {
        await safeWrite("artifact", JSON.stringify({ messageId, artifact }));
      }
      await safeWrite(
        "done",
        JSON.stringify({
          conversationId: body.conversationId,
          messageId,
          createdAt: messageCreatedAt,
        }),
      );
    } finally {
      clearTurnActive(body.conversationId);
    }
  });
}

export async function listConversations(db: Db, userId: string, page: number) {
  const data = await chatRepo.listConversationsForUser(db, userId, page);
  return { data, meta: { page, pageSize: chatRepo.CONVERSATIONS_PAGE_SIZE } };
}

export async function getConversation(db: Db, userId: string, conversationId: string) {
  const conversation = await chatRepo.getConversationForUser(db, userId, conversationId);
  if (!conversation) throw new AppError(404, "Conversation not found");
  let messages = await chatRepo.listMessages(db, conversationId);

  const last = messages[messages.length - 1];
  if (last && last.role === "user" && !isTurnActive(conversationId)) {
    await chatRepo.insertMessage(db, conversationId, "assistant", "", null, "interrupted");
    messages = await chatRepo.listMessages(db, conversationId);
  }

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages,
  };
}
