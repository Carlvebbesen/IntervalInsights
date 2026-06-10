import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../logger";
import * as activityRepo from "../../repositories/activity_repository";
import { computeActivityHrStats, computeWorkHrStats } from "../../services/hr_stats_service";
import {
  completeWithoutSegments,
  persistSegmentsAndStructure,
} from "../../services/signature_service";
import type { AnalysisState, GraphConfigurable, GraphDb } from "../graph_state";

/**
 * Compute and persist HR-distribution stats from the already-fetched streams +
 * computed segments, so the heart-rate analysis endpoint can read them off the
 * activities row without re-fetching from Strava. Best-effort: a failure here
 * must not fail the analysis (the endpoint will lazily recompute later).
 */
async function persistHrStats(db: GraphDb, state: AnalysisState): Promise<void> {
  if (!state.streams) return;
  try {
    const full = computeActivityHrStats(state.streams);
    const work = computeWorkHrStats(state.streams, state.computedSegments);
    await activityRepo.updateHrStats(db, state.activityId, { full, work });
  } catch (err) {
    logger
      .child({ node: "persistResults", activityId: state.activityId })
      .warn({ err }, "failed to persist HR stats (non-fatal)");
  }
}

export async function persistResults(
  state: AnalysisState,
  config: RunnableConfig,
): Promise<Partial<AnalysisState>> {
  const { db } = config.configurable as GraphConfigurable;
  const log = logger.child({ node: "persistResults", activityId: state.activityId });

  const trainingType = state.confirmedTrainingType ?? state.initialResult?.training_type;
  if (!trainingType) {
    throw new Error("persistResults called without a resolved trainingType");
  }

  if (state.computedSegments.length === 0 || !state.signatureCheck) {
    await completeWithoutSegments(db, {
      activityId: state.activityId,
      trainingType,
      userNotes: state.userNotes,
      feeling: state.feeling,
    });
    await persistHrStats(db, state);
    log.info("no segments — wrote status=completed");
    return {};
  }

  await persistSegmentsAndStructure(db, {
    activityId: state.activityId,
    userId: state.userId,
    trainingType,
    segments: state.computedSegments,
    check: state.signatureCheck,
    userNotes: state.userNotes,
    feeling: state.feeling,
    persistSegments: true,
    draftOverride: null,
  });
  await persistHrStats(db, state);
  log.info({ segments: state.computedSegments.length }, "persisted segments, status=completed");
  return {};
}
