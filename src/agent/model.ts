import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import {
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_SYSTEM_VALUE_OPENAI,
} from "@opentelemetry/semantic-conventions/incubating";
import { sleep } from "bun";
import type { z } from "zod";
import { logger } from "../logger";
import { recordTokenUsage } from "../otel";

export const ANALYSIS_VERSION = "v4.0";

const MODEL_NAME = "gpt-4o-mini";

class TokenUsageCallback extends BaseCallbackHandler {
  name = "OtelTokenUsage";
  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (!usage) return;
    recordTokenUsage(
      {
        system: GEN_AI_SYSTEM_VALUE_OPENAI,
        model: MODEL_NAME,
        operation: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      },
      { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
    );
  }
}

export const gptMiniModel = new ChatOpenAI({
  model: MODEL_NAME,
  temperature: 0,
  maxRetries: 2,
  timeout: 45_000,
  callbacks: [new TokenUsageCallback()],
});

const MAX_STRUCTURED_ATTEMPTS = 2;

export async function invokeStructured<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  prompt: string,
  label: string,
): Promise<T | null> {
  // Retry transient structured-output failures (timeouts, malformed/parse errors)
  // before giving up. Returns null after exhausting (callers treat null as a hard
  // failure → activity goes to `error`, which /pending then auto-retries).
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    try {
      return await gptMiniModel.withStructuredOutput<T>(schema).invoke(prompt);
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, label, attempt, maxAttempts: MAX_STRUCTURED_ATTEMPTS },
        `Structured output failed for ${label}${attempt < MAX_STRUCTURED_ATTEMPTS ? " — retrying" : ""}`,
      );
    }
  }
  logger.error({ err: lastErr, label }, `Failed to ${label} after ${MAX_STRUCTURED_ATTEMPTS} attempts`);
  return null;
}

const MAX_ATTEMPTS = 3;

export async function invokeWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const err = error as { message?: string; status?: number; headers?: Record<string, string> };
      const msg = err?.message ?? "";
      const isRateLimit = err?.status === 429 || msg.includes("429");
      if (!isRateLimit || attempt >= MAX_ATTEMPTS) throw error;

      const retryAfterHeader = err?.headers?.["retry-after"];
      const retryAfterSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : Number.NaN;
      const base = Number.isFinite(retryAfterSec)
        ? retryAfterSec * 1000
        : 2000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 750);
      const waitMs = Math.max(1000, base + jitter);
      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, waitMs },
        "OpenAI 429 — waiting before retry",
      );
      await sleep(waitMs);
    }
  }
}
