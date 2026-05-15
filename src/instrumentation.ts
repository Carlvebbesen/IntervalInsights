import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions/incubating";
import { initializeOTEL } from "langsmith/experimental/otel/setup";

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.log("OpenTelemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set");
} else {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "intervals-backend",
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? process.env.GIT_SHA ?? "dev",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15_000,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-pg": { enhancedDatabaseReporting: true },
        "@opentelemetry/instrumentation-undici": { enabled: true },
        // PinoInstrumentation relies on require-in-the-middle, which doesn't
        // activate under Bun's loader — leave it off. Pino → OTel forwarding
        // is wired manually in src/logger.ts via a custom destination.
        "@opentelemetry/instrumentation-pino": { enabled: false },
        // Incoming HTTP spans are created by @hono/otel with Hono route paths.
        // Keep outgoing-client spans only.
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: () => true,
        },
      }),
    ],
  });

  sdk.start();

  // Wire LangSmith's OTel emitter into the global tracer provider that NodeSDK
  // just registered. LangChain v1 + LangGraph runs will then emit GenAI semconv
  // spans (gen_ai.system / .request.model / .usage.*_tokens, plus
  // langsmith.span.kind for graph nodes) through the same OTLP exporter as
  // everything else — visible in Grafana's GenAI view.
  // Requires LANGSMITH_OTEL_ENABLED=true and LANGSMITH_TRACING=true at runtime.
  if (process.env.LANGSMITH_OTEL_ENABLED === "true") {
    initializeOTEL({ globalTracerProvider: trace.getTracerProvider() });
  }

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch (err) {
      console.error("OpenTelemetry shutdown error", err);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
