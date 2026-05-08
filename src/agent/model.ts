import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";

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
