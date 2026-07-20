import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { trainingBucketFor } from "../../../schema/enums";
import {
  applyPlanInputPatch,
  describePlanInputPatch,
  extractPlanInputPatch,
} from "../feedback_intent";
import { estimatePlannedSessionDistanceMeters, isHardSession } from "../guards";
import { MAX_REVIEW_ROUNDS, PlanReviewResumeSchema } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";

/**
 * One compact row per week. The athlete is asked to approve the WHOLE plan, so
 * a single sample week is not enough to approve on — but the full session list
 * of a 20-week plan would bloat the SSE frame, so each week is reduced to the
 * handful of facts an approval actually turns on.
 */
function weekSummaries(state: PlanBuilderState) {
  return state.sessionsByWeek.map((w) => {
    const macroWeek = state.macro?.weeks.find((m) => m.weekIndex === w.weekIndex);
    const long = w.sessions.find((s) => trainingBucketFor(s.sessionType) === "LONG");
    return {
      weekIndex: w.weekIndex,
      startDate: macroWeek?.startDate ?? null,
      phase: macroWeek?.phase ?? null,
      targetDistanceMeters: macroWeek?.targetDistanceMeters ?? null,
      plannedDistanceMeters: w.sessions.reduce(
        (n, s) => n + estimatePlannedSessionDistanceMeters(s.structure, s.description),
        0,
      ),
      sessionCount: w.sessions.length,
      qualityCount: w.sessions.filter((s) => isHardSession(s.sessionType, s.structure)).length,
      longRunDate: long?.date ?? null,
      keySessions: w.sessions
        .filter((s) => isHardSession(s.sessionType, s.structure))
        .map((s) => s.title),
    };
  });
}

export async function sessionsReview(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "sessionsReview", userId: state.userId });
  const round = state.sessionsFeedback.length;

  const buildWeekIndex = state.macro?.weeks.find((w) => w.phase === "build")?.weekIndex ?? 1;
  const sampleWeek =
    state.sessionsByWeek.find((w) => w.weekIndex === buildWeekIndex) ??
    state.sessionsByWeek[0] ??
    null;
  const weeks = weekSummaries(state);
  const totals = {
    weeks: weeks.length,
    sessions: weeks.reduce((n, w) => n + w.sessionCount, 0),
    qualitySessions: weeks.reduce((n, w) => n + w.qualityCount, 0),
    plannedDistanceMeters: weeks.reduce((n, w) => n + w.plannedDistanceMeters, 0),
  };

  const raw = interrupt({
    phase: "sessions_review",
    sampleWeek,
    weeks,
    totals,
    notices: [...state.feedbackNotices, ...state.guardNotices],
    round,
    maxRounds: MAX_REVIEW_ROUNDS,
    roundsRemaining: Math.max(0, MAX_REVIEW_ROUNDS - round),
  });

  const parsed = PlanReviewResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid sessions-review resume payload: ${parsed.error.message}`);
  }

  if (parsed.data.action !== "adjust") {
    log.info("sessions accepted");
    return { action: "accept", feedbackNotices: [] };
  }

  if (round >= MAX_REVIEW_ROUNDS) {
    log.info({ round }, "sessions adjust refused — revision rounds exhausted");
    return {
      action: "accept",
      feedbackNotices: [
        {
          kind: "clamped",
          code: "review_rounds_exhausted",
          message: `You have used all ${MAX_REVIEW_ROUNDS} revision rounds, so this round of feedback was not applied and the plan is being saved as shown. Every session stays editable afterwards.`,
          observed: round,
          limit: MAX_REVIEW_ROUNDS,
        },
      ],
    };
  }

  const patch = await extractPlanInputPatch(parsed.data.feedback, state.input, "sessions");
  log.info(
    { round, patched: Object.keys(patch) },
    "sessions adjust — looping back to generateSessions",
  );
  return {
    action: "adjust",
    sessionsFeedback: [...state.sessionsFeedback, parsed.data.feedback],
    input: applyPlanInputPatch(state.input, patch),
    feedbackNotices: describePlanInputPatch(patch),
  };
}
