import {
  capLongestRunSpike,
  capMaxWeekly,
  clampWeeklyRamp,
  enforceDaysPerWeek,
  estimatePlannedSessionDistanceMeters,
  IMPLIED_LONG_RUN_FRACTION,
  isHardSession,
  qualityCap,
  resolveDaysPerWeek,
  stripPaces,
  VOLUME_RAMP,
} from "../agent/planning/guards";
import type {
  ActiveHealthEvent,
  IntensityAggressiveness,
  VolumeAggressiveness,
} from "../agent/planning/plan_builder_state";
import type { PlanWeekPhase, TrainingType } from "../schema/enums";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";

/**
 * Data-model invariant applied to EVERY plan write, whatever the surface
 * (REST, coach chat, MCP): the plan stores intent, not paces (D8). Needs no
 * athlete context, so unlike the physiological guards it is safe to enforce.
 */
export function enforcePlanWriteInvariants<T extends WorkoutStructureSet[] | null | undefined>(
  structure: T,
): T extends undefined ? undefined : WorkoutStructureSet[] | null {
  // `undefined` must survive: on a PATCH it means "leave the stored structure alone".
  type Result = T extends undefined ? undefined : WorkoutStructureSet[] | null;
  if (structure === undefined) return undefined as Result;
  return stripPaces(structure) as Result;
}

export type PlanGuardWarningCode =
  | "weekly_ramp_exceeded"
  | "long_run_spike"
  | "quality_sessions_exceeded"
  | "days_per_week_exceeded"
  | "max_weekly_volume_exceeded";

export type PlanGuardWarning = {
  code: PlanGuardWarningCode;
  message: string;
  observed: number;
  limit: number;
  weekIndex: number;
};

/** Athlete context the physiological guards compare against. Assembled by `plan_context_service`. */
export type PlanGuardContext = {
  volumeAggressiveness: VolumeAggressiveness;
  intensityAggressiveness: IntensityAggressiveness;
  maxWeeklyVolumeMeters: number | null;
  daysPerWeek: number | null;
  preferredLongRunDay: number | null;
  baselineWeeklyMeters: number | null;
  longestRunMeters: number | null;
  raceDistanceMeters: number | null;
  activeInjuries: ActiveHealthEvent[];
};

/**
 * `weekIndex` is the plan's stored (caller-facing) index and is only reported
 * back; `ordinal` is the week's 0-based position in the plan, which is what the
 * ramp and long-run ceilings grow off. The two differ because plan-builder weeks
 * are 1-based while REST/MCP callers may index from 0.
 */
export type PlanGuardWeek = {
  weekIndex: number;
  ordinal: number;
  phase: PlanWeekPhase | null;
  previousWeekDistanceMeters: number | null;
};

export type PlanGuardSession = {
  date: string;
  sessionType: TrainingType;
  title: string;
  description: string | null;
  structure: WorkoutStructureSet[] | null;
};

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

export function weekVolumeMeters(sessions: PlanGuardSession[]): number {
  return sessions.reduce(
    (sum, s) => sum + estimatePlannedSessionDistanceMeters(s.structure, s.description),
    0,
  );
}

/**
 * Compare-don't-mutate counterpart to the plan-builder's week assembly: run the
 * same pure guards over what the caller actually wrote and report every
 * divergence as a warning. Never rejects and never rewrites — a human may
 * deliberately want a big week, and an LLM caller is expected to self-correct.
 */
export function evaluatePlanWeek(
  ctx: PlanGuardContext,
  week: PlanGuardWeek,
  sessions: PlanGuardSession[],
): PlanGuardWarning[] {
  const warnings: PlanGuardWarning[] = [];
  const observed = weekVolumeMeters(sessions);

  const prev = week.previousWeekDistanceMeters;
  if (prev != null && prev > 0 && observed > 0) {
    const ramp = VOLUME_RAMP[ctx.volumeAggressiveness];
    const [, allowed] = clampWeeklyRamp([prev, observed], ramp.ceiling, ramp.burst);
    if (allowed < observed) {
      warnings.push({
        code: "weekly_ramp_exceeded",
        message: `Week ${week.weekIndex} ramps to ${km(observed)} from ${km(prev)}; the ${ctx.volumeAggressiveness} ramp ceiling allows ${km(allowed)}. Over-ramping is the top cause of running injury.`,
        observed,
        limit: allowed,
        weekIndex: week.weekIndex,
      });
    }
  }

  if (ctx.longestRunMeters != null && ctx.longestRunMeters > 0 && observed > 0) {
    // capLongestRunSpike is elementwise — index i is the ceiling's growth
    // exponent — so padding with zeros evaluates this week at its own ordinal.
    const padded = [...Array(week.ordinal).fill(0), observed];
    const allowed = capLongestRunSpike(padded, ctx.longestRunMeters)[week.ordinal];
    if (allowed < observed) {
      const impliedLong = Math.round(observed * IMPLIED_LONG_RUN_FRACTION);
      const limitLong = Math.round(allowed * IMPLIED_LONG_RUN_FRACTION);
      warnings.push({
        code: "long_run_spike",
        message: `Week ${week.weekIndex}'s volume implies a long run of ~${km(impliedLong)} against a recent longest of ${km(ctx.longestRunMeters)}; ~${km(limitLong)} is the safe ceiling. A sudden long-run jump is a stronger injury signal than weekly volume.`,
        observed: impliedLong,
        limit: limitLong,
        weekIndex: week.weekIndex,
      });
    }
  }

  if (week.phase != null) {
    const cap = qualityCap(week.phase, ctx.intensityAggressiveness);
    const hard = sessions.filter((s) => isHardSession(s.sessionType, s.structure)).length;
    if (hard > cap) {
      warnings.push({
        code: "quality_sessions_exceeded",
        message: `Week ${week.weekIndex} has ${hard} quality sessions; a ${week.phase} week at ${ctx.intensityAggressiveness} intensity supports ${cap}. Polarized training wants ≥80% of running easy.`,
        observed: hard,
        limit: cap,
        weekIndex: week.weekIndex,
      });
    }
  }

  if (ctx.daysPerWeek != null) {
    const cap = resolveDaysPerWeek(ctx.daysPerWeek, null);
    if (enforceDaysPerWeek(sessions, cap).length < sessions.length) {
      warnings.push({
        code: "days_per_week_exceeded",
        message: `Week ${week.weekIndex} schedules ${sessions.length} sessions; the athlete's plan is set to ${cap} run days per week.`,
        observed: sessions.length,
        limit: cap,
        weekIndex: week.weekIndex,
      });
    }
  }

  if (ctx.maxWeeklyVolumeMeters != null && observed > 0) {
    const [allowed] = capMaxWeekly([observed], ctx.maxWeeklyVolumeMeters);
    if (allowed < observed) {
      warnings.push({
        code: "max_weekly_volume_exceeded",
        message: `Week ${week.weekIndex} totals ${km(observed)}, over the athlete's ${km(ctx.maxWeeklyVolumeMeters)} weekly ceiling.`,
        observed,
        limit: allowed,
        weekIndex: week.weekIndex,
      });
    }
  }

  return warnings;
}
