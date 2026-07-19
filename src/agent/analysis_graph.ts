import { END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { AnalysisStateAnnotation } from "./graph_state";
import { awaitUserInput } from "./nodes/await_user_input";
import { detectEvents } from "./nodes/detect_events";
import { maybeEnrichWithIntervalsIcu } from "./nodes/enrich_intervals_icu";
import { fetchActivityContext } from "./nodes/fetch_activity_context";
import { matchPlannedSession } from "./nodes/match_planned_session";
import { persistResults } from "./nodes/persist_results";
import { proposeSegments } from "./nodes/propose_segments";
import { runCompleteAnalysis } from "./nodes/run_complete_analysis";
import { runInitialAgent } from "./nodes/run_initial_agent";
import { validateSignature } from "./nodes/validate_signature";

let _checkpointerPromise: Promise<PostgresSaver> | null = null;

export function getCheckpointer(): Promise<PostgresSaver> {
  if (!_checkpointerPromise) {
    _checkpointerPromise = (async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not set");
      const pool = new pg.Pool({ connectionString: databaseUrl });
      const cp = new PostgresSaver(pool);
      await cp.setup();
      return cp;
    })().catch((err) => {
      _checkpointerPromise = null;
      throw err;
    });
  }
  return _checkpointerPromise;
}

export async function resetAnalysisThread(activityId: number): Promise<void> {
  const checkpointer = await getCheckpointer();
  await checkpointer.deleteThread(String(activityId));
}

const workflow = new StateGraph(AnalysisStateAnnotation)
  .addNode("fetchActivityContext", fetchActivityContext)
  .addNode("maybeEnrichWithIntervalsIcu", maybeEnrichWithIntervalsIcu)
  .addNode("runInitialAgent", runInitialAgent)
  .addNode("proposeSegments", proposeSegments)
  .addNode("awaitUserInput", awaitUserInput)
  .addNode("runCompleteAnalysis", runCompleteAnalysis)
  .addNode("validateSignature", validateSignature)
  .addNode("persistResults", persistResults)
  .addNode("matchPlannedSession", matchPlannedSession)
  .addNode("detectEvents", detectEvents)
  .addEdge(START, "fetchActivityContext")
  .addEdge("fetchActivityContext", "maybeEnrichWithIntervalsIcu")
  .addEdge("maybeEnrichWithIntervalsIcu", "runInitialAgent")
  .addEdge("runInitialAgent", "proposeSegments")
  .addEdge("proposeSegments", "awaitUserInput")
  .addEdge("awaitUserInput", "runCompleteAnalysis")
  .addEdge("runCompleteAnalysis", "validateSignature")
  .addEdge("validateSignature", "persistResults")
  .addEdge("persistResults", "matchPlannedSession")
  .addEdge("matchPlannedSession", "detectEvents")
  .addEdge("detectEvents", END);

let _compiledGraphPromise: Promise<ReturnType<typeof workflow.compile>> | null = null;

export function buildAnalysisGraph(): Promise<ReturnType<typeof workflow.compile>> {
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
