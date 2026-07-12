import { Command } from "@langchain/langgraph";
import { and, eq, inArray } from "drizzle-orm";
import { buildAnalysisGraph } from "../agent/analysis_graph";
import type { SegmentBoundary } from "../agent/graph_state";
import { type Logger, logger } from "../logger";
import { assignActivityToGear } from "../repositories/gear_repository";
import { findOrCreateUserSettings } from "../repositories/user_settings_repository";
import { activities, users } from "../schema";
import type { AnalysisReviewMode, AnalysisStatus, TrainingType } from "../schema/enums";
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IGlobalBindings } from "../types/IRouters";
import { createGearSuggester } from "./gear_suggestion_service";
import { progressService } from "./progress_service";
import { applyDeclaredPacesPositionally } from "./text_intent_service";
import {
  generateCompleteIntervalSet,
  needCompleteAnalysis,
  resolveResumeTrainingType,
} from "./utils";

// Thrown for user-input validation problems in the resume flow. Distinct from
// a server-side error so the router can map it to 400.
export class ResumeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeValidationError";
  }
}

// A resume that found the thread already past its interrupt: the analysis was
// completed or never started. A subclass of ResumeValidationError so the router
// keeps mapping it to 400, but a distinct type so the auto-resume path can
// recognise the "user won the race" case precisely instead of by message match.
export class NoPendingInterruptError extends ResumeValidationError {
  constructor(message: string) {
    super(message);
    this.name = "NoPendingInterruptError";
  }
}

type DoneStatus = "completed" | "initial" | "error";

export function toDoneStatus(
  status: AnalysisStatus | null | undefined,
  fallback: DoneStatus,
): DoneStatus {
  if (status === "completed" || status === "initial" || status === "error") return status;
  return fallback;
}

// Flip to `error` only while the run is still in an in-flight status: a late
// failure (e.g. after persistResults wrote `completed`, or a duplicate resume
// on a finished thread) must not clobber a terminal status and trigger the
// requeue's auto-rerun.
export async function markErrorIfStatusIn(
  db: IGlobalBindings["db"],
  activityId: number,
  statuses: AnalysisStatus[],
  log: Logger,
): Promise<void> {
  try {
    await db
      .update(activities)
      .set({ analysisStatus: "error" })
      .where(and(eq(activities.id, activityId), inArray(activities.analysisStatus, statuses)));
  } catch (dbErr) {
    log.error({ err: dbErr }, "Could not set error status in DB");
  }
}

export async function getUserContext(
  db: IGlobalBindings["db"],
  userId: string,
): Promise<{ intervalsAthleteId: string | null } | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { intervalsAthleteId: true },
  });
  if (!user) return null;
  return { intervalsAthleteId: user.intervalsAthleteId ?? null };
}

export const resumeAnalysis = async (
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  notes: string,
  sets: ExpandedIntervalSet[],
  trainingType: TrainingType | null,
  feeling: number | null,
  editedSegments: SegmentBoundary[] = [],
): Promise<void> => {
  const log = logger.child({ fn: "resumeAnalysis", activityId });
  log.info(
    {
      notesLen: notes.length,
      sets: sets.length,
      trainingType,
      feeling,
      editedSegments: editedSegments.length,
    },
    "starting resume",
  );

  const current = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: {
      trainingType: true,
      draftAnalysisResult: true,
      analysisStatus: true,
      userId: true,
    },
  });
  if (!current) {
    throw new Error(`Activity ${activityId} not found`);
  }
  const draftType = (current.draftAnalysisResult as { training_type?: TrainingType } | null)
    ?.training_type;
  const finalTrainingType = resolveResumeTrainingType(
    trainingType,
    draftType ?? null,
    current.trainingType ?? null,
  );

  if (!finalTrainingType) {
    throw new Error(`Cannot resume activity ${activityId} — no training type resolved`);
  }

  // Interval-type sessions need a structure for the complete-analysis LLM to
  // anchor on. If the user submitted no sets and the initial agent also
  // produced none, fail fast with a user-facing message instead of either
  // hanging the LLM call or marking the activity as a server error.
  if (needCompleteAnalysis(finalTrainingType)) {
    const draftStructureLen =
      (current.draftAnalysisResult as { structure?: unknown[] } | null)?.structure?.length ?? 0;
    if (sets.length === 0 && draftStructureLen === 0) {
      throw new ResumeValidationError(
        "Define an interval structure before completing — no sets were submitted and the initial analysis did not produce one.",
      );
    }
  }

  const userCtx = await getUserContext(db, current.userId);
  if (!userCtx) {
    throw new Error(`User for activity ${activityId} not found`);
  }

  log.info("graph-path: invoking Command resume");
  const graph = await buildAnalysisGraph();
  const graphConfig = {
    configurable: {
      thread_id: String(activityId),
      db,
      stravaAccessToken,
      intervalsAthleteId: userCtx.intervalsAthleteId,
    },
  };

  // Pre-check OUTSIDE the try: a duplicate/late resume (double-tap, client
  // retry after completion) is a request problem, not a run failure — it must
  // map to 400 and never flip a `completed` activity to `error` (which would
  // trigger the requeue's full auto-rerun).
  const before = await graph.getState(graphConfig);
  const beforeInterrupts = before.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
  const hasPendingWork = before.next.length > 0;
  log.info({ next: before.next, taskInterrupts: beforeInterrupts }, "pre-invoke graph state");
  if (!hasPendingWork && beforeInterrupts === 0) {
    throw new NoPendingInterruptError(
      `Cannot resume activity ${activityId} — thread has no pending interrupt. The analysis may already be completed or was never started.`,
    );
  }

  await progressService.publish(current.userId, {
    type: "progress",
    data: { id: activityId, kind: "analysis", phase: "processing" },
  });

  try {
    await graph.invoke(
      new Command({
        resume: { notes, sets, trainingType: finalTrainingType, feeling, editedSegments },
      }),
      graphConfig,
    );
    log.info("graph.invoke returned without throwing");
  } catch (err) {
    log.error({ err }, "FAILED");
    await markErrorIfStatusIn(db, activityId, ["initial", "ongoing_completed"], log);
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: "error" },
    });
    throw err;
  }

  const after = await graph.getState(graphConfig);
  const afterInterrupts = after.tasks.reduce((sum, t) => sum + t.interrupts.length, 0);
  const final = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: { analysisStatus: true },
  });
  if (afterInterrupts > 0) {
    // Still parked at an interrupt: the resume didn't progress, but nothing
    // failed server-side — leave the status alone so the user can resubmit.
    await progressService.publish(current.userId, {
      type: "done",
      data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "initial") },
    });
    throw new Error(
      `Graph resume did not progress activity ${activityId} — still paused at interrupt (next=[${after.next.join(",")}])`,
    );
  }

  await progressService.publish(current.userId, {
    type: "done",
    data: { id: activityId, analysisStatus: toDoneStatus(final?.analysisStatus, "completed") },
  });
};

/**
 * Which activities auto-complete without human review, per the user's
 * `analysisReviewMode`. `none` bypasses review for everything; `intervals_only`
 * bypasses it for non-interval drafts (TEMPO included — it gets no per-segment
 * breakdown, so there is nothing structural to review). `draftType` MUST be the
 * reconciled draft type, never the possibly-stale `activities.trainingType`.
 */
export function computeShouldAutoResume(
  mode: AnalysisReviewMode,
  draftType: TrainingType | null,
): boolean {
  if (draftType == null) return false;
  return mode === "none" || (mode === "intervals_only" && !needCompleteAnalysis(draftType));
}

type AutoResumeActivity = {
  localGearId: number | null;
  sportType: string;
  indoor: boolean;
  gearUpdatedFromStrava: boolean;
  intervalStructureId: number | null;
};

// Auto-assign gear from the default-rules engine before an auto-resume, but only
// when Strava tagged none (ingest already linked the tagged case). A suggestion
// failure must never block the resume.
async function maybeAutoAssignGear(
  db: IGlobalBindings["db"],
  userId: string,
  activityId: number,
  activity: AutoResumeActivity,
  draftType: TrainingType | null,
  log: Logger,
): Promise<void> {
  if (activity.localGearId != null) return;
  try {
    const suggestFor = await createGearSuggester(db, userId);
    const { suggestedGearId } = await suggestFor({
      sportType: activity.sportType,
      indoor: activity.indoor,
      trainingType: draftType,
      localGearId: activity.localGearId,
      gearUpdatedFromStrava: activity.gearUpdatedFromStrava,
      intervalStructureId: activity.intervalStructureId,
    });
    if (suggestedGearId != null) {
      await assignActivityToGear(db, userId, activityId, suggestedGearId);
      log.info({ activityId, suggestedGearId }, "auto-assigned gear before resume");
    }
  } catch (err) {
    log.warn({ err, activityId }, "auto gear suggestion failed — resuming without gear");
  }
}

/**
 * Post-invoke hook (D4/D5): when a just-started activity paused at `initial` and
 * the user's review-mode setting bypasses review for its draft type, assign gear
 * and resume the analysis in the user's absence. Never throws — the start itself
 * already succeeded. Failure modes:
 *  - user submitted their own resume first (NoPendingInterruptError) → success,
 *    their input stands.
 *  - a pre-mutation validation failure (e.g. a structureless interval draft,
 *    thrown before resumeAnalysis touches the status) → the row naturally stays
 *    `initial`, so it still surfaces for manual review.
 *  - a genuine mid-graph resume failure → the thread has already consumed its
 *    interrupt, so the row is left at `error` and follows the existing
 *    bounded-retry requeue path instead of a fresh `initial` that would let a
 *    later manual resume silently ignore the user's submitted input.
 */
export async function maybeAutoResumeAnalysis(
  db: IGlobalBindings["db"],
  stravaAccessToken: string,
  activityId: number,
  userId: string,
  log: Logger,
): Promise<void> {
  const activity = await db.query.activities.findFirst({
    where: eq(activities.id, activityId),
    columns: {
      analysisStatus: true,
      draftAnalysisResult: true,
      localGearId: true,
      sportType: true,
      indoor: true,
      gearUpdatedFromStrava: true,
      intervalStructureId: true,
    },
  });
  if (activity?.analysisStatus !== "initial") return;

  const settings = await findOrCreateUserSettings(db, userId);
  if (!settings) return;

  const draftType =
    (activity.draftAnalysisResult as { training_type?: TrainingType } | null)?.training_type ??
    null;
  if (!computeShouldAutoResume(settings.analysisReviewMode, draftType)) return;

  await maybeAutoAssignGear(db, userId, activityId, activity, draftType, log);

  // D6: carry text-declared paces into the auto-resumed analysis. Only when the
  // draft's structure came from the title/description (`structureSource === "text"`)
  // and at least one work step had an explicitly-stated pace — otherwise resume
  // with empty sets exactly as before (the draft structure hydrates with null paces).
  const draft = activity.draftAnalysisResult;
  const declaredPaces = draft?.structureSource === "text" ? draft.declaredPaces : null;
  const draftStructure = draft?.structure;
  const autoSets: ExpandedIntervalSet[] =
    declaredPaces && draftStructure?.length && declaredPaces.some((p) => p != null)
      ? applyDeclaredPacesPositionally(generateCompleteIntervalSet(draftStructure), declaredPaces)
      : [];

  try {
    await resumeAnalysis(db, stravaAccessToken, activityId, "", autoSets, null, null, []);
    log.info({ activityId, mode: settings.analysisReviewMode }, "auto-resume completed analysis");
  } catch (err) {
    if (err instanceof NoPendingInterruptError) {
      log.info({ activityId }, "auto-resume no-op — user resume already claimed the interrupt");
      return;
    }
    log.warn(
      { err, activityId },
      "auto-resume failed — row stays at its current status (initial pre-mutation, error post-mutation) for the requeue/manual-review fallback",
    );
  }
}
