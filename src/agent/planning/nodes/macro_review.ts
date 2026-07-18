import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { PlanReviewResumeSchema } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";

export async function macroReview(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "macroReview", userId: state.userId });

  const raw = interrupt({ phase: "macro_review", macro: state.macro });

  const parsed = PlanReviewResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid macro-review resume payload: ${parsed.error.message}`);
  }

  if (parsed.data.action === "adjust") {
    log.info("macro adjust — looping back to proposeMacro");
    return { action: "adjust", macroFeedback: [...state.macroFeedback, parsed.data.feedback] };
  }
  log.info("macro accepted");
  return { action: "accept" };
}
