import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { logger } from "../../../logger";
import { invokeWithRateLimitRetry } from "../../model";
import { assembleWeekSessions, MAX_CROSS_TRAINING_PER_WEEK, resolveDaysPerWeek } from "../guards";
import type { GeneratedWeekSessions } from "../plan_builder_schemas";
import {
  type AthleteContext,
  DEFAULT_INTENSITY_AGGRESSIVENESS,
  type PlanBuilderState,
} from "../plan_builder_state";
import { invokeGenerateSessionsAgent, SESSION_BATCH_WEEKS } from "../plan_sessions_agent";

/** Observed average run days/week from the athlete's recent weeks (null when no history). */
function observedRunDaysPerWeek(ctx: AthleteContext): number | null {
  const weeks = ctx.recentWeeks;
  if (weeks.length === 0) return null;
  const total = weeks.reduce(
    (n, w) => n + Object.values(w.typeCounts).reduce((a, b) => a + b, 0),
    0,
  );
  return total / weeks.length;
}

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

  const guardParams = {
    intensityAggressiveness:
      state.input.intensityAggressiveness ?? DEFAULT_INTENSITY_AGGRESSIVENESS,
    daysPerWeek: resolveDaysPerWeek(state.input.daysPerWeek, observedRunDaysPerWeek(ctx)),
    preferredLongRunDay: state.input.preferredLongRunDay ?? null,
    crossTrainingCount:
      ctx.activeHealthEvents.length === 0
        ? 0
        : Math.min(MAX_CROSS_TRAINING_PER_WEEK, ctx.activeHealthEvents.length),
  };

  for (let i = 0; i < totalWeeks; i += SESSION_BATCH_WEEKS) {
    const batch = macro.weeks.slice(i, i + SESSION_BATCH_WEEKS);
    const raw = await invokeWithRateLimitRetry(() =>
      invokeGenerateSessionsAgent(ctx, batch, state.sessionsFeedback),
    );
    for (const week of batch) {
      const llmWeek = raw?.weeks.find((w) => w.weekIndex === week.weekIndex);
      sessionsByWeek.push({
        weekIndex: week.weekIndex,
        sessions: assembleWeekSessions(week, llmWeek?.sessions ?? [], guardParams),
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
