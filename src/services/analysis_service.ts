import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { buildAnalysisGraph, resetAnalysisThread } from "../agent/analysis_graph";
import { logger } from "../logger";
import { activities } from "../schema";
import {
  ACTIVE_RUN_STATUSES,
  type AnalysisStatus,
  SKIP_RESTART_STATUSES,
  SKIP_START_STATUSES,
} from "../schema/enums";
import type { IGlobalBindings } from "../types/IRouters";
import { progressService } from "./progress_service";
import {
  getUserContext,
  markErrorIfStatusIn,
  maybeAutoResumeAnalysis,
  toDoneStatus,
} from "./resume_analysis";

export {
  NoPendingInterruptError,
  ResumeValidationError,
  resumeAnalysis,
} from "./resume_analysis";

export const startAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  stravaActivityId: number | null | undefined,
  userId: string,
  force = false,
): Promise<void> => {
  const log = logger.child({ fn: "startAnalysis", activityId, force });
  // Atomic claim: flip to ongoing_init only if no other starter got there first.
  // A read-then-invoke check leaves a window where two starters (webhook +
  // manual + requeue) both pass, then each resetAnalysisThread deletes the
  // other's checkpoints mid-run. `force` is the user-driven re-analyze path
  // (details view): it may re-run a completed/paused activity, but never one
  // whose graph is actively running.
  const blockedStatuses: AnalysisStatus[] = force
    ? [...ACTIVE_RUN_STATUSES]
    : [...SKIP_START_STATUSES];
  const claimed = await db
    .update(activities)
    .set({ analysisStatus: "ongoing_init", analysisStartedAt: new Date() })
    .where(
      and(
        eq(activities.id, activityId),
        or(
          isNull(activities.analysisStatus),
          notInArray(activities.analysisStatus, blockedStatuses),
        ),
      ),
    )
    .returning({ id: activities.id });
  if (claimed.length === 0) {
    log.info("skipping — another run already claimed or completed this activity");
    return;
  }

  const userCtx = await getUserContext(db, userId);
  if (!userCtx) {
    log.error({ userId }, "user not found — releasing claim");
    await markErrorIfStatusIn(db, activityId, ["ongoing_init"], log);
    return;
  }

  // Always start from a clean checkpoint. Without this, an invoke layered on
  // top of a stale thread (e.g. from a prior dev session or a different state
  // schema) silently corrupts the run and resume crashes later with empty
  // state.streams / state.activityId. resetAnalysisThread is a no-op when no
  // thread exists, so this is safe to call unconditionally here.
  await resetAnalysisThread(activityId);

  await progressService.publish(userId, {
    type: "progress",
    data: { id: activityId, kind: "analysis", phase: "processing", analysisStatus: "ongoing_init" },
  });

  try {
    const graph = await buildAnalysisGraph();
    await graph.invoke(
      { activityId, stravaActivityId: stravaActivityId ?? null, userId },
      {
        configurable: {
          thread_id: String(activityId),
          db,
          stravaAccessToken,
          intervalsAthleteId: userCtx.intervalsAthleteId,
        },
      },
    );

    // Auto-resume in the user's absence when their review-mode setting bypasses
    // human review (D4/D5). A no-op for the default `all` mode; never throws —
    // any failure leaves the row at `initial` for manual review.
    await maybeAutoResumeAnalysis(db, stravaAccessToken, activityId, userId, log);

    const final = await db.query.activities.findFirst({
      where: eq(activities.id, activityId),
      columns: { analysisStatus: true },
    });
    await progressService.publish(userId, {
      type: "done",
      data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "initial") },
    });
  } catch (err) {
    log.error({ err }, "Error in startAnalysis");
    await markErrorIfStatusIn(db, activityId, ["pending", "ongoing_init"], log);
    await progressService.publish(userId, {
      type: "done",
      data: { id: activityId, analysisStatus: "error" },
    });
  }
};

export const triggerAnalysisByStravaId = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  stravaActivityId: number,
  userId: string,
): Promise<void> => {
  const result = await db.query.activities.findFirst({
    where: eq(activities.stravaActivityId, stravaActivityId),
    columns: { id: true, analysisStatus: true },
  });
  if (!result) {
    logger.error({ stravaActivityId }, "Activity not found in DB");
    return;
  }

  if (result.analysisStatus && SKIP_RESTART_STATUSES.has(result.analysisStatus)) {
    logger.info(
      { activityId: result.id, status: result.analysisStatus },
      "Skipping restart — analysis in progress",
    );
    return;
  }

  // startAnalysis resets the thread itself, no need to do it twice.
  await startAnalysis(db, stravaAccessToken, result.id, stravaActivityId, userId);
};
