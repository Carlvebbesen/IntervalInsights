import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import { matchActivityToPlannedSession } from "../../services/planned_session_matcher";
import { toISODate } from "../../services/utils";
import type { AnalysisState, GraphConfigurable } from "../graph_state";

export async function matchPlannedSession(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const log = logger.child({ node: "matchPlannedSession", activityId: state.activityId });
  const { db } = config.configurable as GraphConfigurable;

  try {
    if (!state.activityStartDateLocal) {
      log.warn("no activityStartDateLocal on state — skipping planned-session match");
      return {};
    }

    const intervalsCount = state.computedSegments.filter((s) => s.type === "INTERVALS").length;
    const structureRepCount = state.computedSegments.length > 0 ? intervalsCount : null;

    const result = await matchActivityToPlannedSession(db, {
      userId: state.userId,
      activityId: state.activityId,
      activityDateLocal: toISODate(state.activityStartDateLocal),
      trainingType: state.confirmedTrainingType,
      sportType: state.activityType,
      structureRepCount,
    });
    log.info({ linked: result.linked, sessionId: result.sessionId }, "finished");
  } catch (err) {
    log.error({ err }, "planned session match failed — keeping completed analysis");
  }
  return {};
}
