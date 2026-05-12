import type { RunnableConfig } from "@langchain/core/runnables";
import { detectAndPersistEvents } from "../../services.ts/event_detection_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function detectEvents(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  await detectAndPersistEvents(db, {
    activityId: state.activityId,
    userId: state.userId,
    title: state.activityTitle,
    description: state.activityDescription,
    notes: state.userNotes,
    activityStartDateLocal: state.activityStartDateLocal,
  });
  return {};
}
