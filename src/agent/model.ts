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

// Analysis-pipeline models. gpt-4o-mini is the default for every structured
// agent. The stronger tiers exist so the reasoning-heavy agents (classification +
// structure extraction) can be A/B'd / promoted PER-AGENT via invokeStructured's
// `model` arg. Verified against the OpenAI lineup 2026-06 (o4-mini = cost-effective
// o-series reasoning, supports structured outputs; gpt-4.1 = strong general).
const MINI_MODEL = "gpt-4o-mini";
const STRONG_MODEL = "gpt-4.1"; // strong general model, drop-in (supports temperature)
const REASONING_MODEL = "o4-mini"; // o-series: ignores temperature, uses reasoningEffort

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

/**
 * Stronger tiers for the reasoning-heavy structured agents. `gptStrongModel` is
 * wired into suggest-session "recommended" mode (open-ended coaching judgment
 * where mini just echoes its input); pass one explicitly to
 * `invokeStructured(..., model)` to A/B others. `gptStrongModel` is a drop-in (temperature 0);
 * `o4ReasoningModel` is an o-series reasoning model (no temperature — it reasons
 * at the default effort; bind `reasoningEffort` per-call to tune) with a longer
 * timeout since reasoning runs are slower.
 */
export const gptStrongModel = new ChatOpenAI({
  model: STRONG_MODEL,
  temperature: 0,
  maxRetries: 2,
  timeout: 60_000,
  callbacks: [new TokenUsageCallback(STRONG_MODEL)],
});

/**
 * Strong model at a non-zero temperature, for open-ended *generation* where we
 * WANT variety across otherwise-identical inputs (suggest-session "recommended"
 * mode: re-asking should yield a genuinely different session, not the same one).
 * Do NOT use for extraction/classification — those must stay deterministic.
 */
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

export async function invokeStructured<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  prompt: string,
  label: string,
  model: ChatOpenAI = gptMiniModel,
): Promise<T | null> {
  // Retry transient structured-output failures (timeouts, malformed/parse errors)
  // before giving up. Returns null after exhausting (callers treat null as a hard
  // failure → activity goes to `error`, which /pending then auto-retries).
  // `model` defaults to gpt-4o-mini; pass a stronger tier for reasoning-heavy agents.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    try {
      return await model.withStructuredOutput<T>(schema).invoke(prompt);
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
