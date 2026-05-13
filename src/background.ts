import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { logger as rootLogger } from "./logger";

const tracer = trace.getTracer("intervals-backend");

type BackgroundOptions = {
  attributes?: Record<string, string | number | boolean | undefined>;
  logger?: typeof rootLogger;
};

// Schedules a fire-and-forget async task as a child of the current span so that
// log records emitted inside the task carry the originating trace_id/span_id and
// the work shows up under the request trace in Tempo/Grafana. Errors are
// recorded on the span and logged once — callers no longer need .catch().
export function runInBackground(
  name: string,
  fn: () => Promise<unknown>,
  options: BackgroundOptions = {},
): void {
  const log = options.logger ?? rootLogger;
  const parentCtx = context.active();
  const span = tracer.startSpan(name, undefined, parentCtx);
  if (options.attributes) {
    for (const [key, value] of Object.entries(options.attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
  }
  const ctx = trace.setSpan(parentCtx, span);
  context.with(ctx, () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        log.error({ err, task: name }, `Background task "${name}" failed`);
      })
      .finally(() => span.end());
  });
}
