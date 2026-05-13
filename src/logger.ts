import pino from "pino";

// Root logger. PinoInstrumentation (in src/instrumentation.ts) injects
// trace_id/span_id automatically and forwards records to the OTLP log exporter.
// Service/agent modules import this directly; routers should prefer
// c.var.logger (a request-scoped child created by @hono/structured-logger).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: process.env.OTEL_SERVICE_NAME ?? "intervals-backend" },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
