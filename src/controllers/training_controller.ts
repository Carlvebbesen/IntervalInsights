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
import type { CoachArtifact, CoachChatRequest } from "../schemas/api_schemas";
import { isReviewUser } from "../services/review_account";
import type { IGlobalBindings, TStravaEnv } from "../types/IRouters";

type Db = IGlobalBindings["db"];

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

const activeTurns = new Set<string>();

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
        // The demo user's stravaId is a sentinel with no real link/token, so
        // provider-backed tools must read as unavailable — chat runs on DB tools.
        stravaLinked: !isReviewUser(userId) && !!user?.stravaId,
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

    if (activeTurns.has(body.conversationId)) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "A reply is already in progress for this conversation." }),
      );
      return;
    }
    activeTurns.add(body.conversationId);

    try {
      let persist = true;
      try {
        await chatRepo.insertMessage(db, body.conversationId, "user", body.message);
      } catch (err) {
        log.error({ err }, "coach: failed to persist user message");
        persist = false;
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
          return;
        }
        log.error({ err }, "coach: graph run failed");
        await safeWrite(
          "error",
          JSON.stringify({ error: "The coach hit an error answering that." }),
        );
        return;
      }

      let messageId: number | null = null;
      let messageCreatedAt: string | null = null;
      if (persist) {
        try {
          const row = await chatRepo.insertMessage(
            db,
            body.conversationId,
            "assistant",
            finalAnswer,
            artifacts,
          );
          messageId = row.id;
          messageCreatedAt = row.createdAt.toISOString();
        } catch (err) {
          log.error({ err }, "coach: failed to persist assistant message");
        }
      }

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
      activeTurns.delete(body.conversationId);
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
  const messages = await chatRepo.listMessages(db, conversationId);
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages,
  };
}
