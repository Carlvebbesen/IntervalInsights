import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import {
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_SYSTEM_VALUE_OPENAI,
} from "@opentelemetry/semantic-conventions/incubating";
import { recordTokenUsage } from "../../otel";

function tokenUsageCallback(model: string): BaseCallbackHandler {
  return new (class extends BaseCallbackHandler {
    name = "OtelTokenUsage";
    async handleLLMEnd(output: LLMResult): Promise<void> {
      const usage = output.llmOutput?.tokenUsage as
        | { promptTokens?: number; completionTokens?: number }
        | undefined;
      if (!usage) return;
      recordTokenUsage(
        {
          system: GEN_AI_SYSTEM_VALUE_OPENAI,
          model,
          operation: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        },
        { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
      );
    }
  })();
}

export const COACH_MODEL_NAME = "gpt-4o";

export const coachModel = new ChatOpenAI({
  model: COACH_MODEL_NAME,
  temperature: 0.2,
  maxRetries: 2,
  timeout: 60_000,
  callbacks: [tokenUsageCallback(COACH_MODEL_NAME)],
});
