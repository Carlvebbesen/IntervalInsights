import type { SSEStreamingApi } from "hono/streaming";
import { config } from "../config";

export type SafeWrite = (event: string, data: string) => Promise<void>;

/**
 * SSE writer that serializes every write onto one promise chain so the
 * concurrent heartbeat can never interleave a `ping` frame into the middle of
 * another SSE event. A failed write marks the client gone and aborts the run.
 */
export function buildSafeWrite(stream: SSEStreamingApi, abort: AbortController): SafeWrite {
  let clientGone = false;
  let chain: Promise<void> = Promise.resolve();
  return (event: string, data: string) => {
    chain = chain.then(async () => {
      if (clientGone) return;
      try {
        await stream.writeSSE({ event, data });
      } catch {
        clientGone = true;
        abort.abort();
      }
    });
    return chain;
  };
}

/**
 * Keep an SSE connection producing bytes while a node runs a long, silent
 * LLM call. Bun's per-request `server.timeout(req, 0)` only disables Bun's own
 * idle timer — upstream proxies (Railway edge, ~5min) close a byte-silent
 * stream regardless. A periodic `ping` keeps every layer's idle timer reset.
 * Fires one immediately so the stream is never silent, then on an interval.
 * Returns a stop function to call in a `finally`.
 */
export function startSseHeartbeat(
  safeWrite: SafeWrite,
  intervalMs: number = config.SSE_HEARTBEAT_MS,
): () => void {
  let stopped = false;
  const tick = () => {
    if (!stopped) void safeWrite("ping", "{}");
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
