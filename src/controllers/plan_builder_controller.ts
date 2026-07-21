import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { buildPlanBuilderGraph } from "../agent/planning/plan_builder_graph";
import type { PlanReviewResume } from "../agent/planning/plan_builder_schemas";
import { collectNotices, type PlanBuilderInput } from "../agent/planning/plan_builder_state";
import { AppError } from "../error";
import type { Logger } from "../logger";
import type { TGlobalEnv } from "../types/IRouters";
import { clearTurnActive, isTurnActive, markTurnActive } from "./active_turns";
import { buildSafeWrite, startSseHeartbeat } from "./sse_heartbeat";

type Db = TGlobalEnv["Bindings"]["db"];
type PlanBuilderGraph = Awaited<ReturnType<typeof buildPlanBuilderGraph>>;
type PlanBuilderRunInput = Parameters<PlanBuilderGraph["stream"]>[0];

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
  // The terminal event must carry the notices too. The sessions gate converts a
  // 4th `adjust` into `accept` plus a `review_rounds_exhausted` notice and then
  // runs straight to persistPlan → END, so `done` is the only frame left to
  // deliver it on — without this, REST callers get a success for feedback that
  // was silently discarded.
  await safeWrite(
    "done",
    JSON.stringify({
      planId: state.values.persistedPlanId,
      threadId,
      notices: collectNotices(state.values),
    }),
  );
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
  const stopHeartbeat = startSseHeartbeat(safeWrite);
  try {
    const events = await graph.stream(runInput, {
      ...threadConfig(threadId, db),
      streamMode: ["updates", "custom"],
      signal,
    });
    for await (const event of events) {
      const [mode, data] = event as [string, Record<string, unknown>];
      if (mode === "custom") {
        const chunk = data as {
          phase?: string;
          completedWeeks?: number;
          totalWeeks?: number;
        };
        if (chunk.phase === "sessions_progress") {
          await safeWrite(
            "status",
            JSON.stringify({
              node: "generateSessions",
              completedWeeks: chunk.completedWeeks,
              totalWeeks: chunk.totalWeeks,
            }),
          );
        }
        continue;
      }
      const nodeName = Object.keys(data)[0];
      // `__interrupt__` (and other `__`-prefixed internals) are LangGraph's own
      // update chunks, not real nodes — the terminal `interrupt` event carries
      // the payload; don't leak them as `status`.
      if (nodeName && !nodeName.startsWith("__")) {
        await safeWrite("status", JSON.stringify({ node: nodeName }));
      }
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
  } finally {
    stopHeartbeat();
  }
}

// A second concurrent stream for the same thread gets an SSE error event
// instead of racing the checkpointer.
function streamPlanBuilderRun(
  c: Context<TGlobalEnv>,
  graph: PlanBuilderGraph,
  runInput: PlanBuilderRunInput,
  threadId: string,
  { emitStarted = false }: { emitStarted?: boolean } = {},
): Response {
  const db = c.env.db;
  const log = c.var.logger;

  (c.env as { timeout?: (req: Request, seconds: number) => void }).timeout?.(c.req.raw, 0);

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const safeWrite = buildSafeWrite(stream, abort);

    if (isTurnActive(threadId)) {
      await safeWrite(
        "error",
        JSON.stringify({ error: "A plan-builder step is already in progress for this thread." }),
      );
      return;
    }
    markTurnActive(threadId);

    try {
      if (emitStarted) await safeWrite("started", JSON.stringify({ threadId }));

      const ok = await runStream(graph, runInput, threadId, db, abort.signal, safeWrite, log);
      if (!ok) return;

      await emitTerminalEvent(graph, threadId, db, safeWrite);
    } finally {
      clearTurnActive(threadId);
    }
  });
}

export async function generateTrainingPlan(
  c: Context<TGlobalEnv>,
  input: PlanBuilderInput,
): Promise<Response> {
  const userId = c.get("userId");
  const graph = await buildPlanBuilderGraph();
  const threadId = `plan-builder:${randomUUID()}`;
  return streamPlanBuilderRun(c, graph, { userId, input }, threadId, { emitStarted: true });
}

export async function resumeTrainingPlan(
  c: Context<TGlobalEnv>,
  threadId: string,
  resume: PlanReviewResume,
): Promise<Response> {
  const db = c.env.db;
  const userId = c.get("userId");

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

  return streamPlanBuilderRun(c, graph, new Command({ resume }), threadId);
}
