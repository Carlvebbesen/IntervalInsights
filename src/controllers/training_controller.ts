import { HumanMessage } from "@langchain/core/messages";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { SAFE_REFUSAL } from "../agent/training/prompts";
import type { CoachCtx } from "../agent/training/tool_types";
import { buildTrainingGraph } from "../agent/training/training_graph";
import { AppError } from "../error";
import * as chatRepo from "../repositories/chat_repository";
import * as userRepo from "../repositories/user_repository";
import type { CoachArtifact, CoachChatRequest } from "../schemas/api_schemas";
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

export function streamCoachChat(c: Context<TStravaEnv>, body: CoachChatRequest): Response {
  const db = c.env.db;
  const userId = c.get("userId");
  const clerkUserId = c.get("clerkUserId");
  const stravaAccessToken = c.get("stravaAccessToken");
  const log = c.var.logger;

  return streamSSE(c, async (stream) => {
    let ctx: CoachCtx;
    try {
      const user = await userRepo.findById(db, userId);
      ctx = {
        db,
        userId,
        clerkUserId,
        stravaAccessToken,
        intervalsConnected: !!user?.intervalsAthleteId,
        userTime: body.userTime,
        weather: body.weather,
        logger: log,
      };
    } catch (err) {
      log.error({ err }, "coach: failed to build context");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "Failed to start." }),
      });
      return;
    }

    let persist = true;
    try {
      const owned = await chatRepo.ensureConversation(
        db,
        userId,
        body.conversationId,
        deriveTitle(body.message),
      );
      if (!owned) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "conversationId belongs to another conversation." }),
        });
        return;
      }
      await chatRepo.insertMessage(db, body.conversationId, "user", body.message);
    } catch (err) {
      log.error({ err }, "coach: failed to persist user message");
      persist = false;
    }

    const graph = await buildTrainingGraph();
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
      });
      for await (const event of events) {
        const [mode, data] = event as [string, unknown];
        if (mode === "custom") {
          await stream.writeSSE({ event: "status", data: JSON.stringify(data) });
        } else if (mode === "values") {
          const v = data as { finalAnswer?: string | null; pendingArtifacts?: CoachArtifact[] };
          if (v.finalAnswer) finalAnswer = v.finalAnswer;
          if (v.pendingArtifacts) artifacts = v.pendingArtifacts;
        }
      }
    } catch (err) {
      log.error({ err }, "coach: graph run failed");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "The coach hit an error answering that." }),
      });
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
      await stream.writeSSE({ event: "token", data: JSON.stringify({ text: piece }) });
    }
    for (const artifact of artifacts) {
      await stream.writeSSE({ event: "artifact", data: JSON.stringify({ messageId, artifact }) });
    }
    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        conversationId: body.conversationId,
        messageId,
        createdAt: messageCreatedAt,
      }),
    });
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
