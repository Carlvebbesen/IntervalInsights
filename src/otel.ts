import { SpanKind, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
} from "@opentelemetry/semantic-conventions/incubating";

// Bun's native `fetch` doesn't go through undici, so
// @opentelemetry/instrumentation-undici / -http never patch it. This module
// emits the standard `http.client.request.duration` histogram and a CLIENT-kind
// span manually, so Strava / intervals.icu calls become visible in Tempo and
// Prometheus.

const meter = metrics.getMeter("intervals-backend");
const tracer = trace.getTracer("intervals-backend");

const httpClientDuration = meter.createHistogram("http.client.request.duration", {
  description: "Duration of outbound HTTP requests",
  unit: "s",
});

const genAiTokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
  description: "Number of input and output tokens used per GenAI request",
  unit: "{token}",
});

// Templatize path segments that look like IDs (3+ digits, optional leading
// letter) so span names stay low-cardinality. Matches Strava activity IDs
// (numeric, 9-11 digits), intervals.icu IDs (`i12345`), Strava gear IDs
// (`g1234567`), while leaving version segments like `v3` untouched.
const ID_SEGMENT = /\/[a-zA-Z]?\d{3,}/g;

export async function tracedFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  const method = (init.method ?? "GET").toUpperCase();
  const scheme = url.protocol.replace(":", "");
  const port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80;
  const route = url.pathname.replace(ID_SEGMENT, "/:id");
  const spanName = `${method} ${url.host}${route}`;

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_URL_FULL]: url.toString(),
        [ATTR_URL_SCHEME]: scheme,
        [ATTR_SERVER_ADDRESS]: url.host,
        [ATTR_SERVER_PORT]: port,
      },
    },
    async (span) => {
      const start = performance.now();
      const baseMetricAttrs = {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_URL_SCHEME]: scheme,
        [ATTR_SERVER_ADDRESS]: url.host,
      };
      try {
        const res = await fetch(input, init);
        const durationSec = (performance.now() - start) / 1000;
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.status);
        httpClientDuration.record(durationSec, {
          ...baseMetricAttrs,
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: res.status,
        });
        if (res.status >= 400) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
        }
        return res;
      } catch (err) {
        const durationSec = (performance.now() - start) / 1000;
        const errorType = err instanceof Error ? err.name : "unknown";
        httpClientDuration.record(durationSec, {
          ...baseMetricAttrs,
          [ATTR_ERROR_TYPE]: errorType,
        });
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export function recordTokenUsage(
  attrs: { system: string; model: string; operation?: string },
  usage: { inputTokens?: number; outputTokens?: number },
): void {
  const base = {
    [ATTR_GEN_AI_SYSTEM]: attrs.system,
    [ATTR_GEN_AI_REQUEST_MODEL]: attrs.model,
    [ATTR_GEN_AI_OPERATION_NAME]: attrs.operation ?? GEN_AI_OPERATION_NAME_VALUE_CHAT,
  };
  if (usage.inputTokens != null) {
    genAiTokenUsage.record(usage.inputTokens, {
      ...base,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
    });
  }
  if (usage.outputTokens != null) {
    genAiTokenUsage.record(usage.outputTokens, {
      ...base,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
    });
  }
}
