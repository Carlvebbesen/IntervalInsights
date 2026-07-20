import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import {
  applyPlanInputPatch,
  describePlanInputPatch,
  extractPlanInputPatch,
} from "../feedback_intent";
import { MAX_REVIEW_ROUNDS, PlanReviewResumeSchema } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";

export async function macroReview(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "macroReview", userId: state.userId });
  const round = state.macroFeedback.length;

  const raw = interrupt({
    phase: "macro_review",
    macro: state.macro,
    notices: [...state.feedbackNotices, ...state.guardNotices],
    round,
    maxRounds: MAX_REVIEW_ROUNDS,
    roundsRemaining: Math.max(0, MAX_REVIEW_ROUNDS - round),
  });

  const parsed = PlanReviewResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid macro-review resume payload: ${parsed.error.message}`);
  }

  if (parsed.data.action !== "adjust") {
    log.info("macro accepted");
    return { action: "accept", feedbackNotices: [] };
  }

  if (round >= MAX_REVIEW_ROUNDS) {
    log.info({ round }, "macro adjust refused — revision rounds exhausted");
    return {
      action: "accept",
      feedbackNotices: [
        {
          kind: "clamped",
          code: "review_rounds_exhausted",
          message: `You have used all ${MAX_REVIEW_ROUNDS} revision rounds for the plan structure, so this round of feedback was not applied and the plan moves on to its sessions. You can edit any week directly once the plan is saved, or start a fresh plan to change the structure.`,
          observed: round,
          limit: MAX_REVIEW_ROUNDS,
        },
      ],
    };
  }

  const patch = await extractPlanInputPatch(parsed.data.feedback, state.input, "macro");
  log.info({ round, patched: Object.keys(patch) }, "macro adjust — looping back to proposeMacro");
  return {
    action: "adjust",
    macroFeedback: [...state.macroFeedback, parsed.data.feedback],
    input: applyPlanInputPatch(state.input, patch),
    feedbackNotices: describePlanInputPatch(patch),
  };
}
