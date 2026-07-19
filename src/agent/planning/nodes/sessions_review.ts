import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { PlanReviewResumeSchema } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";

export async function sessionsReview(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "sessionsReview", userId: state.userId });

  const buildWeekIndex = state.macro?.weeks.find((w) => w.phase === "build")?.weekIndex ?? 1;
  const sampleWeek =
    state.sessionsByWeek.find((w) => w.weekIndex === buildWeekIndex) ??
    state.sessionsByWeek[0] ??
    null;
  const totals = {
    weeks: state.sessionsByWeek.length,
    sessions: state.sessionsByWeek.reduce((n, w) => n + w.sessions.length, 0),
  };

  const raw = interrupt({ phase: "sessions_review", sampleWeek, totals });

  const parsed = PlanReviewResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid sessions-review resume payload: ${parsed.error.message}`);
  }

  if (parsed.data.action === "adjust") {
    log.info("sessions adjust — looping back to generateSessions");
    return {
      action: "adjust",
      sessionsFeedback: [...state.sessionsFeedback, parsed.data.feedback],
    };
  }
  log.info("sessions accepted");
  return { action: "accept" };
}
