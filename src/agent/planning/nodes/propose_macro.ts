import { logger } from "../../../logger";
import { invokeWithRateLimitRetry } from "../../model";
import { shapeMacro } from "../guards";
import { DEFAULT_VOLUME_AGGRESSIVENESS, type PlanBuilderState } from "../plan_builder_state";
import { invokeProposeMacroAgent } from "../plan_macro_agent";

export async function proposeMacro(state: PlanBuilderState): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "proposeMacro", userId: state.userId });
  const ctx = state.athleteContext;
  if (!ctx) throw new Error("proposeMacro requires athleteContext");

  const raw = await invokeWithRateLimitRetry(() =>
    invokeProposeMacroAgent(ctx, state.input, state.macroFeedback),
  );
  if (!raw) throw new Error("proposeMacro: LLM returned no macro plan");

  const { macro, notices } = shapeMacro(raw, state.input, {
    baselineWeeklyMeters: ctx.baselineVolume?.trailing4WeekAvgWeeklyMeters ?? null,
    longestRunMeters: ctx.baselineVolume?.longestRunLast30dMeters ?? null,
    provenWeeklyMeters: ctx.baselineVolume?.provenWeeklyMeters ?? null,
    provenLongestRunMeters: ctx.baselineVolume?.provenLongestRunMeters ?? null,
    volumeAggressiveness: state.input.volumeAggressiveness ?? DEFAULT_VOLUME_AGGRESSIVENESS,
    maxWeeklyVolumeMeters: state.input.maxWeeklyVolumeMeters ?? null,
    raceDistanceMeters: ctx.race?.distanceMeters ?? null,
  });
  log.info(
    {
      weeks: macro.weeks.length,
      feedbackRounds: state.macroFeedback.length,
      guardNotices: notices.length,
    },
    "proposed macro",
  );
  return { macro, action: null, guardNotices: notices };
}
