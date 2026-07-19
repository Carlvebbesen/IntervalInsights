import { END, START, StateGraph } from "@langchain/langgraph";
import { getCheckpointer } from "../analysis_graph";
import { gatherContext } from "./nodes/gather_context";
import { generateSessions } from "./nodes/generate_sessions";
import { macroReview } from "./nodes/macro_review";
import { persistPlan } from "./nodes/persist_plan";
import { proposeMacro } from "./nodes/propose_macro";
import { sessionsReview } from "./nodes/sessions_review";
import { type PlanBuilderState, PlanBuilderStateAnnotation } from "./plan_builder_state";

export async function resetPlanBuilderThread(threadId: string): Promise<void> {
  const checkpointer = await getCheckpointer();
  await checkpointer.deleteThread(threadId);
}

function routeAfterMacroReview(state: PlanBuilderState): "proposeMacro" | "generateSessions" {
  return state.action === "adjust" ? "proposeMacro" : "generateSessions";
}

function routeAfterSessionsReview(state: PlanBuilderState): "generateSessions" | "persistPlan" {
  return state.action === "adjust" ? "generateSessions" : "persistPlan";
}

const workflow = new StateGraph(PlanBuilderStateAnnotation)
  .addNode("gatherContext", gatherContext)
  .addNode("proposeMacro", proposeMacro)
  .addNode("macroReview", macroReview)
  .addNode("generateSessions", generateSessions)
  .addNode("sessionsReview", sessionsReview)
  .addNode("persistPlan", persistPlan)
  .addEdge(START, "gatherContext")
  .addEdge("gatherContext", "proposeMacro")
  .addEdge("proposeMacro", "macroReview")
  .addConditionalEdges("macroReview", routeAfterMacroReview, {
    proposeMacro: "proposeMacro",
    generateSessions: "generateSessions",
  })
  .addEdge("generateSessions", "sessionsReview")
  .addConditionalEdges("sessionsReview", routeAfterSessionsReview, {
    generateSessions: "generateSessions",
    persistPlan: "persistPlan",
  })
  .addEdge("persistPlan", END);

let _compiledGraphPromise: Promise<ReturnType<typeof workflow.compile>> | null = null;

export function buildPlanBuilderGraph(): Promise<ReturnType<typeof workflow.compile>> {
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
