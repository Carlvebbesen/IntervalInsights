import type { RunnableConfig } from "@langchain/core/runnables";
import { detectAndPersistEvents } from "../../services.ts/event_detection_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function detectEvents(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const tag = `[detectEvents activity=${state.activityId}]`;
  const { db } = config.configurable as GraphConfigurable;
  console.log(
    `${tag} entering: title.len=${state.activityTitle.length} description.len=${state.activityDescription.length} userNotes.len=${state.userNotes.length}`,
  );
  await detectAndPersistEvents(db, {
    activityId: state.activityId,
    userId: state.userId,
    title: state.activityTitle,
    description: state.activityDescription,
    notes: state.userNotes,
    activityStartDateLocal: state.activityStartDateLocal,
  });
  console.log(`${tag} finished`);
  return {};
}
