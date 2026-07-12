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

const MINI_MODEL = "gpt-4o-mini";
const STRONG_MODEL = "gpt-4.1";
const REASONING_MODEL = "o4-mini";

class TokenUsageCallback extends BaseCallbackHandler {
  name = "OtelTokenUsage";
  constructor(private readonly modelName: string) {
    super();
  }
  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (!usage) return;
    recordTokenUsage(
      {
        system: GEN_AI_SYSTEM_VALUE_OPENAI,
        model: this.modelName,
        operation: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      },
      { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
    );
  }
}

export const gptMiniModel = new ChatOpenAI({
  model: MINI_MODEL,
  temperature: 0,
  maxRetries: 2,
  timeout: 45_000,
  callbacks: [new TokenUsageCallback(MINI_MODEL)],
});

export const gptStrongModel = new ChatOpenAI({
  model: STRONG_MODEL,
  temperature: 0,
  maxRetries: 2,
  timeout: 60_000,
  callbacks: [new TokenUsageCallback(STRONG_MODEL)],
});

export const gptStrongCreativeModel = new ChatOpenAI({
  model: STRONG_MODEL,
  temperature: 0.6,
  maxRetries: 2,
  timeout: 60_000,
  callbacks: [new TokenUsageCallback(STRONG_MODEL)],
});

export const o4ReasoningModel = new ChatOpenAI({
  model: REASONING_MODEL,
  maxRetries: 2,
  timeout: 90_000,
  callbacks: [new TokenUsageCallback(REASONING_MODEL)],
});

const MAX_STRUCTURED_ATTEMPTS = 2;

export function isRateLimitError(error: unknown): boolean {
  const err = error as { status?: number; code?: string } | undefined;
  return err?.status === 429 || err?.code === "rate_limit_exceeded";
}

export async function invokeStructured<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  prompt: string,
  label: string,
  model: ChatOpenAI = gptMiniModel,
): Promise<T | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    try {
      return await model.withStructuredOutput<T>(schema).invoke(prompt);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      lastErr = err;
      logger.warn(
        { err, label, attempt, maxAttempts: MAX_STRUCTURED_ATTEMPTS },
        `Structured output failed for ${label}${attempt < MAX_STRUCTURED_ATTEMPTS ? " — retrying" : ""}`,
      );
    }
  }
  logger.error(
    { err: lastErr, label },
    `Failed to ${label} after ${MAX_STRUCTURED_ATTEMPTS} attempts`,
  );
  return null;
}

const MAX_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

function retryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: unknown })?.headers;
  let raw: string | null | undefined;
  if (headers instanceof Headers) {
    raw = headers.get("retry-after");
  } else if (headers && typeof headers === "object") {
    raw = (headers as Record<string, string>)["retry-after"];
  }
  const sec = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(sec) ? sec * 1000 : null;
}

export async function invokeWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= MAX_ATTEMPTS) throw error;

      const base = retryAfterMs(error) ?? 2000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 750);
      const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1000, base + jitter));
      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, waitMs },
        "OpenAI 429 — waiting before retry",
      );
      await sleep(waitMs);
    }
  }
}
