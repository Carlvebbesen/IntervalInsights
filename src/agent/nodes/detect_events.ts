import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import { detectAndPersistEvents } from "../../services/event_detection_service";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function detectEvents(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "detectEvents", activityId: state.activityId });
  const { db } = config.configurable as GraphConfigurable;
  log.info(
    {
      titleLen: state.activityTitle.length,
      descriptionLen: state.activityDescription.length,
      userNotesLen: state.userNotes.length,
    },
    "entering",
  );
  // Best-effort: this node runs AFTER persistResults has written `completed`.
  // A throw here would flip a finished analysis to `error` and auto-rerun it.
  try {
    await detectAndPersistEvents(db, {
      activityId: state.activityId,
      userId: state.userId,
      title: state.activityTitle,
      description: state.activityDescription,
      notes: state.userNotes,
      activityStartDateLocal: state.activityStartDateLocal,
    });
    log.info("finished");
  } catch (err) {
    log.error({ err }, "event detection failed — keeping completed analysis");
  }
  return {};
}
