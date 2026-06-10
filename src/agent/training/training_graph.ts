import { isAIMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getCheckpointer } from "../analysis_graph";
import { type TrainingState, TrainingStateAnnotation } from "./graph_state";
import { metaTools } from "./meta_tools";
import { agentNode } from "./nodes/agent_node";
import { verifyNode } from "./nodes/verify_node";
import { visualTools } from "./visual_tools";

function routeAfterAgent(state: TrainingState): "tools" | "verify" {
  const last = state.messages[state.messages.length - 1];
  if (isAIMessage(last) && (last.tool_calls?.length ?? 0) > 0) return "tools";
  return "verify";
}

function routeAfterVerify(state: TrainingState): "agent" | typeof END {
  return state.verdict === "regenerate" ? "agent" : END;
}

const workflow = new StateGraph(TrainingStateAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", new ToolNode([...metaTools, ...visualTools]))
  .addNode("verify", verifyNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", verify: "verify" })
  .addEdge("tools", "agent")
  .addConditionalEdges("verify", routeAfterVerify, { agent: "agent", [END]: END });

let _compiledGraphPromise: Promise<ReturnType<typeof workflow.compile>> | null = null;

export function buildTrainingGraph(): Promise<ReturnType<typeof workflow.compile>> {
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
