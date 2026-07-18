import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import {
  buildPlanBuilderGraph,
  resetPlanBuilderThread,
} from "../agent/planning/plan_builder_graph";
import type { PlanReviewResume } from "../agent/planning/plan_builder_schemas";
import type { PlanBuilderInput } from "../agent/planning/plan_builder_state";
import { AppError } from "../error";
import type { Logger } from "../logger";
import type { TGlobalEnv } from "../types/IRouters";

type Db = TGlobalEnv["Bindings"]["db"];
type PlanBuilderGraph = Awaited<ReturnType<typeof buildPlanBuilderGraph>>;
type PlanBuilderRunInput = Parameters<PlanBuilderGraph["stream"]>[0];

// Shared across generate + resume: a second concurrent stream for the same
// thread gets an SSE error event instead of racing the checkpointer.
const activeThreads = new Set<string>();

function threadConfig(threadId: string, db: Db) {
  return { configurable: { thread_id: threadId, db } };
}

function pendingInterrupt(state: Awaited<ReturnType<PlanBuilderGraph["getState"]>>) {
  return state.tasks.flatMap((t) => t.interrupts)[0];
}

async function emitTerminalEvent(
  graph: PlanBuilderGraph,
  threadId: string,
  db: Db,
  safeWrite: (event: string, data: string) => Promise<void>,
): Promise<void> {
  const state = await graph.getState(threadConfig(threadId, db));
  const interrupt = pendingInterrupt(state);
  if (interrupt) {
    await safeWrite("interrupt", JSON.stringify({ ...(interrupt.value as object), threadId }));
    return;
  }
  await safeWrite("done", JSON.stringify({ planId: state.values.persistedPlanId, threadId }));
}

function buildSafeWrite(stream: SSEStreamingApi, abort: AbortController) {
  let clientGone = false;
  return async (event: string, data: string) => {
    if (clientGone) return;
    try {
      await stream.writeSSE({ event, data });
    } catch {
      clientGone = true;
      abort.abort();
    }
  };
}

async function runStream(
  graph: PlanBuilderGraph,
  runInput: PlanBuilderRunInput,
  threadId: string,
  db: Db,
  signal: AbortSignal,
  safeWrite: (event: string, data: string) => Promise<void>,
  log: Logger,
): Promise<boolean> {
  try {
    const events = await graph.stream(runInput, {
      ...threadConfig(threadId, db),
      streamMode: ["updates"],
      signal,
    });
    for await (const event of events) {
      const [, update] = event as [string, Record<string, unknown>];
      const nodeName = Object.keys(update)[0];
      if (nodeName) await safeWrite("status", JSON.stringify({ node: nodeName }));
    }
    return true;
  } catch (err) {
    if (signal.aborted) {
      log.info("plan-builder: client disconnected — graph aborted");
      return false;
    }
    log.error({ err }, "plan-builder: graph stream failed");
    await safeWrite("error", JSON.stringify({ error: "Failed to generate the plan." }));
    return false;
  }
}

export function generateTrainingPlan(c: Context<TGlobalEnv>, input: PlanBuilderInput): Response {
  const db = c.env.db;
  const userId = c.get("userId");
  const log = c.var.logger;

  (c.env as { timeout?: (req: Request, seconds: number) => void }).timeout?.(c.req.raw, 0);

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const safeWrite = buildSafeWrite(stream, abort);

    const threadId = `plan-builder:${randomUUID()}`;
    if (activeThreads.has(threadId)) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "A plan-builder step is already in progress for this thread." }),
      );
      return;
    }
    activeThreads.add(threadId);

    try {
      await resetPlanBuilderThread(threadId);
      await safeWrite("started", JSON.stringify({ threadId }));

      const graph = await buildPlanBuilderGraph();
      const ok = await runStream(
        graph,
        { userId, input },
        threadId,
        db,
        abort.signal,
        safeWrite,
        log,
      );
      if (!ok) return;

      await emitTerminalEvent(graph, threadId, db, safeWrite);
    } finally {
      activeThreads.delete(threadId);
    }
  });
}

export async function resumeTrainingPlan(
  c: Context<TGlobalEnv>,
  threadId: string,
  resume: PlanReviewResume,
): Promise<Response> {
  const db = c.env.db;
  const userId = c.get("userId");
  const log = c.var.logger;

  const graph = await buildPlanBuilderGraph();
  const state = await graph.getState(threadConfig(threadId, db));

  // Ownership first, and with the same body as "unknown thread": an unknown
  // thread_id has no checkpoint, so `state.values.userId` is undefined and
  // fails this check identically to a real thread owned by someone else.
  // Checking pending-work first would leak existence — an unknown thread and
  // a foreign *pending* thread would otherwise return different statuses
  // (409 vs 404), letting a caller distinguish "no such thread" from
  // "someone else's thread that's still paused."
  if (state.values.userId !== userId) {
    throw new AppError(404, "No pending plan-builder step for this thread");
  }

  const hasPendingWork = state.next.length > 0;
  const interrupt = pendingInterrupt(state);
  if (!hasPendingWork && !interrupt) {
    throw new AppError(409, "No pending plan-builder step for this thread");
  }

  (c.env as { timeout?: (req: Request, seconds: number) => void }).timeout?.(c.req.raw, 0);

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const safeWrite = buildSafeWrite(stream, abort);

    if (activeThreads.has(threadId)) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "A plan-builder step is already in progress for this thread." }),
      );
      return;
    }
    activeThreads.add(threadId);

    try {
      const ok = await runStream(
        graph,
        new Command({ resume }),
        threadId,
        db,
        abort.signal,
        safeWrite,
        log,
      );
      if (!ok) return;

      await emitTerminalEvent(graph, threadId, db, safeWrite);
    } finally {
      activeThreads.delete(threadId);
    }
  });
}
