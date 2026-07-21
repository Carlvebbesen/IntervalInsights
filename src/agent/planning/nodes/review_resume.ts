import type { Logger } from "../../../logger";
import {
  applyPlanInputPatch,
  describePlanInputPatch,
  extractPlanInputPatch,
  FEEDBACK_PROSE_ONLY_NOTICE,
  type PlanReviewStage,
} from "../feedback_intent";
import { MAX_REVIEW_ROUNDS, PlanReviewResumeSchema } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";

type ReviewResumeOptions = {
  stage: PlanReviewStage;
  feedbackKey: "macroFeedback" | "sessionsFeedback";
  exhaustedMessage: string;
  loopTarget: string;
  log: Logger;
};

/**
 * Shared post-interrupt flow for both review gates: parse the resume payload,
 * accept, refuse a round past the cap (with the caller's notice text), or map
 * the feedback onto a plan-input patch and loop back.
 */
export async function resolveReviewResume(
  raw: unknown,
  state: PlanBuilderState,
  { stage, feedbackKey, exhaustedMessage, loopTarget, log }: ReviewResumeOptions,
): Promise<Partial<PlanBuilderState>> {
  const round = state[feedbackKey].length;

  const parsed = PlanReviewResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${stage}-review resume payload: ${parsed.error.message}`);
  }

  if (parsed.data.action !== "adjust") {
    log.info(`${stage} accepted`);
    return { action: "accept", feedbackNotices: [] };
  }

  if (round >= MAX_REVIEW_ROUNDS) {
    log.info({ round }, `${stage} adjust refused — revision rounds exhausted`);
    return {
      action: "accept",
      feedbackNotices: [
        {
          kind: "clamped",
          code: "review_rounds_exhausted",
          message: exhaustedMessage,
          observed: round,
          limit: MAX_REVIEW_ROUNDS,
        },
      ],
    };
  }

  const patch = await extractPlanInputPatch(parsed.data.feedback, state.input, stage);
  log.info(
    { round, patched: Object.keys(patch) },
    `${stage} adjust — looping back to ${loopTarget}`,
  );
  const update: Partial<PlanBuilderState> = {
    action: "adjust",
    input: applyPlanInputPatch(state.input, patch),
    feedbackNotices:
      Object.keys(patch).length > 0 ? describePlanInputPatch(patch) : [FEEDBACK_PROSE_ONLY_NOTICE],
  };
  update[feedbackKey] = [...state[feedbackKey], parsed.data.feedback];
  return update;
}
