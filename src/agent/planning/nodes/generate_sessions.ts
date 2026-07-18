import { logger } from "../../../logger";
import { invokeWithRateLimitRetry } from "../../model";
import { assembleWeekSessions } from "../guards";
import type { GeneratedWeekSessions } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";
import { invokeGenerateSessionsAgent } from "../plan_sessions_agent";

export async function generateSessions(
  state: PlanBuilderState,
): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "generateSessions", userId: state.userId });
  const macro = state.macro;
  const ctx = state.athleteContext;
  if (!macro) throw new Error("generateSessions requires a macro");
  if (!ctx) throw new Error("generateSessions requires athleteContext");

  const raw = await invokeWithRateLimitRetry(() =>
    invokeGenerateSessionsAgent(ctx, macro, state.sessionsFeedback),
  );

  const sessionsByWeek: GeneratedWeekSessions[] = macro.weeks.map((week) => {
    const llmWeek = raw?.weeks.find((w) => w.weekIndex === week.weekIndex);
    return {
      weekIndex: week.weekIndex,
      sessions: assembleWeekSessions(week, llmWeek?.sessions ?? []),
    };
  });

  const total = sessionsByWeek.reduce((n, w) => n + w.sessions.length, 0);
  log.info({ weeks: sessionsByWeek.length, sessions: total }, "generated sessions");
  return { sessionsByWeek, action: null };
}
