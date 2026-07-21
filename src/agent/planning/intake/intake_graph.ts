import { isAIMessage, SystemMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getCheckpointer } from "../../analysis_graph";
import { windowMessages } from "../../training/message_window";
import { intakeSystemPrompt, invokeIntakeModel } from "./intake_agent";
import { type IntakeState, IntakeStateAnnotation } from "./intake_state";
import { intakeTools } from "./intake_tools";

export async function resetIntakeThread(threadId: string): Promise<void> {
  const checkpointer = await getCheckpointer();
  await checkpointer.deleteThread(threadId);
}

async function agentNode(state: IntakeState): Promise<Partial<IntakeState>> {
  const ai = await invokeIntakeModel([
    new SystemMessage(intakeSystemPrompt()),
    ...windowMessages(state.messages),
  ]);
  return { messages: [ai] };
}

function routeAfterAgent(state: IntakeState): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1];
  if (isAIMessage(last) && (last.tool_calls?.length ?? 0) > 0) return "tools";
  return END;
}

const workflow = new StateGraph(IntakeStateAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", new ToolNode(intakeTools))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", [END]: END })
  .addEdge("tools", "agent");

let _compiledGraphPromise: Promise<ReturnType<typeof workflow.compile>> | null = null;

export function buildIntakeGraph(): Promise<ReturnType<typeof workflow.compile>> {
  if (!_compiledGraphPromise) {
    _compiledGraphPromise = (async () => {
      const checkpointer = await getCheckpointer();
      return workflow.compile({ checkpointer });
    })().catch((err) => {
      _compiledGraphPromise = null;
      throw err;
    });
  }
  return _compiledGraphPromise;
}
