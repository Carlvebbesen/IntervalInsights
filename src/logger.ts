import { context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import pino from "pino";

// `@opentelemetry/instrumentation-pino` doesn't activate under Bun (its
// require-in-the-middle hook isn't honored by Bun's loader), so we forward
// Pino records to the OTel LoggerProvider ourselves. The destination writes
// each line to stdout AND emits an OTel LogRecord — trace_id/span_id are
// picked up from the active context, so Grafana trace↔logs correlation works.

const SEVERITY: Record<string, { text: string; number: SeverityNumber }> = {
  trace: { text: "TRACE", number: SeverityNumber.TRACE },
  debug: { text: "DEBUG", number: SeverityNumber.DEBUG },
  info: { text: "INFO", number: SeverityNumber.INFO },
  warn: { text: "WARN", number: SeverityNumber.WARN },
  error: { text: "ERROR", number: SeverityNumber.ERROR },
  fatal: { text: "FATAL", number: SeverityNumber.FATAL },
};

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "intervals-backend";
const otelLogger = logs.getLogger(SERVICE_NAME);
const otelEnabled = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const destination = {
  write(line: string) {
    process.stdout.write(line);
    if (!otelEnabled) return;
    try {
      const record = JSON.parse(line);
      const { level, time, msg, ...attributes } = record;
      const severity = SEVERITY[level] ?? SEVERITY.info;
      otelLogger.emit({
        timestamp: typeof time === "number" ? time : Date.now(),
        severityText: severity.text,
        severityNumber: severity.number,
        body: typeof msg === "string" ? msg : "",
        attributes,
        context: context.active(),
      });
    } catch {
      // Non-JSON or malformed line; skip OTel forwarding but stdout already got it.
    }
  },
};

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
    base: { service: SERVICE_NAME },
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  destination,
);

export type Logger = typeof logger;
