import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { invokeWithRateLimitRetry } from "../../model";
import { assembleWeekSessions } from "../guards";
import type { GeneratedWeekSessions } from "../plan_builder_schemas";
import type { PlanBuilderState } from "../plan_builder_state";
import { invokeGenerateSessionsAgent, SESSION_BATCH_WEEKS } from "../plan_sessions_agent";

export async function generateSessions(
  state: PlanBuilderState,
  config?: LangGraphRunnableConfig,
): Promise<Partial<PlanBuilderState>> {
  const log = logger.child({ node: "generateSessions", userId: state.userId });
  const macro = state.macro;
  const ctx = state.athleteContext;
  if (!macro) throw new Error("generateSessions requires a macro");
  if (!ctx) throw new Error("generateSessions requires athleteContext");

  const totalWeeks = macro.weeks.length;
  const sessionsByWeek: GeneratedWeekSessions[] = [];

  for (let i = 0; i < totalWeeks; i += SESSION_BATCH_WEEKS) {
    const batch = macro.weeks.slice(i, i + SESSION_BATCH_WEEKS);
    const raw = await invokeWithRateLimitRetry(() =>
      invokeGenerateSessionsAgent(ctx, batch, state.sessionsFeedback),
    );
    for (const week of batch) {
      const llmWeek = raw?.weeks.find((w) => w.weekIndex === week.weekIndex);
      sessionsByWeek.push({
        weekIndex: week.weekIndex,
        sessions: assembleWeekSessions(week, llmWeek?.sessions ?? []),
      });
    }
    config?.writer?.({
      phase: "sessions_progress",
      completedWeeks: sessionsByWeek.length,
      totalWeeks,
    });
  }

  const total = sessionsByWeek.reduce((n, w) => n + w.sessions.length, 0);
  log.info({ weeks: sessionsByWeek.length, sessions: total }, "generated sessions");
  return { sessionsByWeek, action: null };
}
