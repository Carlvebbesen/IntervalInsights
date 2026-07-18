import type { RunnableConfig } from "@langchain/core/runnables";
import { logger } from "../../../logger";
import {
  type CreateSessionInput,
  type CreateWeekInput,
  createWithChildren,
} from "../../../repositories/training_plan_repository";
import type { PlanBuilderConfigurable, PlanBuilderState } from "../plan_builder_state";

export async function persistPlan(
  state: PlanBuilderState,
  config: RunnableConfig,
): Promise<Partial<PlanBuilderState>> {
  const { db } = config.configurable as PlanBuilderConfigurable;
  const log = logger.child({ node: "persistPlan", userId: state.userId });
  const macro = state.macro;
  if (!macro) throw new Error("persistPlan requires a macro");

  const weeks: CreateWeekInput[] = macro.weeks.map((w) => {
    const wk = state.sessionsByWeek.find((s) => s.weekIndex === w.weekIndex);
    const sessions: CreateSessionInput[] = (wk?.sessions ?? []).map((s, idx) => ({
      date: s.date,
      sessionType: s.sessionType,
      title: s.title,
      description: s.description ?? null,
      structure: s.structure ?? null,
      sortOrder: idx,
    }));
    return {
      weekIndex: w.weekIndex,
      startDate: w.startDate,
      phase: w.phase,
      targetDistanceMeters: w.targetDistanceMeters,
      notes: w.notes ?? null,
      sessions,
    };
  });

  const detail = await createWithChildren(db, state.userId, {
    name: macro.name || state.input.name || "Training plan",
    startDate: state.input.startDate,
    endDate: state.input.endDate,
    raceEventId: state.input.raceEventId ?? null,
    goalText: state.input.goalText ?? null,
    status: "active",
    meta: {
      createdVia: "plan_builder",
      inputs: state.input,
      rationale: macro.rationale,
      feedbackRounds: {
        macro: state.macroFeedback.length,
        sessions: state.sessionsFeedback.length,
      },
    },
    weeks,
  });

  log.info({ planId: detail.plan.id, weeks: detail.weeks.length }, "persisted plan");
  return { persistedPlanId: detail.plan.id };
}
