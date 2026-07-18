import { logger } from "../../../logger";
import { invokeWithRateLimitRetry } from "../../model";
import { repairMacro } from "../guards";
import type { PlanBuilderState } from "../plan_builder_state";
import { invokeProposeMacroAgent } from "../plan_macro_agent";

export async function proposeMacro(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "proposeMacro", userId: state.userId });
  const ctx = state.athleteContext;
  if (!ctx) throw new Error("proposeMacro requires athleteContext");

  const raw = await invokeWithRateLimitRetry(() =>
    invokeProposeMacroAgent(ctx, state.input, state.macroFeedback),
  );
  if (!raw) throw new Error("proposeMacro: LLM returned no macro plan");

  const macro = repairMacro(raw, state.input);
  log.info(
    { weeks: macro.weeks.length, feedbackRounds: state.macroFeedback.length },
    "proposed macro",
  );
  return { macro, action: null };
}
