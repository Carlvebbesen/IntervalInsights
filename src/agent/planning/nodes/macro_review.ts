import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { MAX_REVIEW_ROUNDS } from "../plan_builder_schemas";
import { collectNotices, type PlanBuilderState, reviewRoundMeta } from "../plan_builder_state";
import { resolveReviewResume } from "./review_resume";

export async function macroReview(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "macroReview", userId: state.userId });
  const round = state.macroFeedback.length;

  const raw = interrupt({
    phase: "macro_review",
    macro: state.macro,
    notices: collectNotices(state),
    ...reviewRoundMeta(round),
  });

  return resolveReviewResume(raw, state, {
    stage: "macro",
    feedbackKey: "macroFeedback",
    exhaustedMessage: `You have used all ${MAX_REVIEW_ROUNDS} revision rounds for the plan structure, so this round of feedback was not applied and the plan moves on to its sessions. You can edit any week directly once the plan is saved, or start a fresh plan to change the structure.`,
    loopTarget: "proposeMacro",
    log,
  });
}
