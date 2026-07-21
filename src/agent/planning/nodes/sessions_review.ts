import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { trainingBucketFor } from "../../../schema/enums";
import { estimatePlannedSessionDistanceMeters, isHardSession } from "../guards";
import { MAX_REVIEW_ROUNDS } from "../plan_builder_schemas";
import { collectNotices, type PlanBuilderState, reviewRoundMeta } from "../plan_builder_state";
import { resolveReviewResume } from "./review_resume";

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
    notices: collectNotices(state),
    ...reviewRoundMeta(round),
  });

  return resolveReviewResume(raw, state, {
    stage: "sessions",
    feedbackKey: "sessionsFeedback",
    exhaustedMessage: `You have used all ${MAX_REVIEW_ROUNDS} revision rounds, so this round of feedback was not applied and the plan is being saved as shown. Every session stays editable afterwards.`,
    loopTarget: "generateSessions",
    log,
  });
}
