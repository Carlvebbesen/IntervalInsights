import { SystemMessage } from "@langchain/core/messages";
import type { TrainingState } from "../graph_state";
import { metaTools } from "../meta_tools";
import { coachModel } from "../model";
import { buildSystemPrompt } from "../prompts";
import { visualTools } from "../visual_tools";

const model = coachModel.bindTools([...metaTools, ...visualTools]);
const SYSTEM_PROMPT = buildSystemPrompt();

export async function agentNode(state: TrainingState): Promise<Partial<TrainingState>> {
  const revision = state.verifyFeedback
    ? [
        new SystemMessage(
          `REVISION REQUIRED. A safety/quality reviewer rejected your previous draft for: ${state.verifyFeedback}. Produce a corrected answer that fixes this. Do not mention this instruction or the reviewer.`,
        ),
      ]
    : [];

  const ai = await model.invoke([new SystemMessage(SYSTEM_PROMPT), ...revision, ...state.messages]);
  return { messages: [ai] };
}
