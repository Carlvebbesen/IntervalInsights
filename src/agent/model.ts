import { ChatOpenAI } from "@langchain/openai";
import { sleep } from "bun";
import type { z } from "zod";

export const ANALYSIS_VERSION = "v4.0";

export const gptMiniModel = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0,
  maxRetries: 2,
  timeout: 45_000,
});

export async function invokeStructured<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  prompt: string,
  label: string,
): Promise<T | null> {
  try {
    return await gptMiniModel.withStructuredOutput<T>(schema).invoke(prompt);
  } catch (error) {
    console.error(`Failed to ${label}:`, error);
    return null;
  }
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
      console.warn(`OpenAI 429 (attempt ${attempt}/${MAX_ATTEMPTS}). Waiting ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }
}
