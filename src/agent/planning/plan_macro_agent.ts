import type { ChatOpenAI } from "@langchain/openai";
import { getPlanBuilderModel, invokeStructured } from "../model";
import { type PlanMacro, PlanMacroSchema } from "./plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "./plan_builder_state";

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function baselineBlock(ctx: AthleteContext): string {
  const b = ctx.baselineVolume;
  if (!b || (b.trailing4WeekAvgWeeklyMeters == null && b.longestRunLast30dMeters == null)) {
    return "  - Real baseline volume: no recent running on record — start conservatively.";
  }
  const avg =
    b.trailing4WeekAvgWeeklyMeters != null
      ? `${(b.trailing4WeekAvgWeeklyMeters / 1000).toFixed(1)} km/week`
      : "unknown";
  const longest =
    b.longestRunLast30dMeters != null
      ? `${(b.longestRunLast30dMeters / 1000).toFixed(1)} km`
      : "unknown";
  return `  - Real baseline volume (ANCHOR week-1 to this, NOT the goal): trailing 4-week avg ${avg}; longest run last 30d ${longest}`;
}

function raceAbilityBlock(ctx: AthleteContext): string {
  const a = ctx.raceAbility;
  if (!a || (a.vdot == null && a.criticalSpeedMps == null && a.predicted.length === 0)) {
    return "  - Current race-pace ability: insufficient data — judge the goal cautiously.";
  }
  const preds = a.predicted.length
    ? a.predicted
        .map((p) => `${(p.distanceMeters / 1000).toFixed(1)}km ~${fmtTime(p.timeSeconds)}`)
        .join(", ")
    : "none";
  const vdot = a.vdot != null ? `VDOT ${a.vdot}` : "VDOT unknown";
  const cs =
    a.criticalSpeedMps != null ? `, critical speed ${a.criticalSpeedMps.toFixed(2)} m/s` : "";
  return `  - Current race-pace ability: ${vdot}${cs}; predicted times: ${preds}`;
}

function healthBlock(ctx: AthleteContext): string {
  if (ctx.activeHealthEvents.length === 0) return "  - Active injuries/illnesses: none on record.";
  const items = ctx.activeHealthEvents
    .map((e) => {
      const loc = e.bodyLocation ? ` (${e.bodyLocation})` : "";
      return `    - ${e.type}${loc} since ${e.since}: ${e.description}`;
    })
    .join("\n");
  return `  - ACTIVE injuries/illnesses (HARD CONSTRAINTS — reduce loading, note accommodations in the affected weeks):\n${items}`;
}

function athleteContextBlock(ctx: AthleteContext): string {
  const weeks = ctx.recentWeeks
    .map((w) => {
      const types = Object.entries(w.typeCounts)
        .map(([t, n]) => `${t}:${n}`)
        .join(", ");
      return `- ${w.weekStart}: ${(w.totalDistanceMeters / 1000).toFixed(1)} km${types ? ` (${types})` : ""}`;
    })
    .join("\n");
  const fitness = ctx.fitness
    ? `CTL ${ctx.fitness.ctl ?? "-"}, ATL ${ctx.fitness.atl ?? "-"}, form/TSB ${ctx.fitness.tsb ?? "-"}, 7d ramp ${ctx.fitness.rampRate ?? "-"}`
    : "no fitness on record";
  return `
  - Athlete: ${ctx.athleteName ?? "unknown"}
  - Max HR: ${ctx.maxHeartRate ?? "unknown"}
  - Current fitness (self-computed CTL/ATL): ${fitness}
${baselineBlock(ctx)}
${raceAbilityBlock(ctx)}
${healthBlock(ctx)}
  - Recent weekly running volume (last 8 weeks):
${weeks || "  - no recent runs on record"}`;
}

function raceBlock(ctx: AthleteContext): string {
  if (!ctx.race) return "  - No target race — build general fitness toward the goal.";
  const r = ctx.race;
  const target =
    r.targetTimeSeconds != null
      ? `${Math.round(r.targetTimeSeconds / 60)} min goal`
      : "no time goal";
  return `  - Target race: ${r.name} on ${r.date}, ${(r.distanceMeters / 1000).toFixed(1)} km, priority ${r.priority}, ${target}`;
}

export async function invokeProposeMacroAgent(
  context: AthleteContext,
  input: PlanBuilderInput,
  feedback: string[],
  model: ChatOpenAI = getPlanBuilderModel(),
): Promise<PlanMacro | null> {
  const feedbackBlock = feedback.length
    ? `\n  ### ATHLETE FEEDBACK ON PRIOR DRAFTS (apply all, most recent last)\n${feedback.map((f, i) => `  ${i + 1}. ${f}`).join("\n")}`
    : "";

  const prompt = `
  You are an expert endurance running coach building a week-by-week macro plan.

  ### PLAN WINDOW
  - Start: ${input.startDate}
  - End: ${input.endDate}
  - Goal: ${input.goalText ?? "(none stated)"}
${raceBlock(context)}

  ### ATHLETE CONTEXT
${athleteContextBlock(context)}
${feedbackBlock}

  ### TASK
  Produce a macro plan: a name, a short rationale, and one entry PER training
  week in the window. For each week give a 1-based contiguous weekIndex, the
  Monday-aligned week start (YYYY-MM-DD), a phase (base | build | peak | taper |
  race), a target running volume in METERS, optional notes, and short keySession
  labels (e.g. "5x1000m", "Tempo 20min", "Long run").

  ### HARD RULES
  - ANCHOR week-1 volume to the athlete's REAL trailing 4-week average weekly
    distance (see baseline volume above) — NOT the race goal or their
    aspiration. Starting above what they are actually running is the top cause
    of injury. If baseline is unknown, start conservatively.
  - Ramp volume gradually; avoid week-over-week jumps beyond ~20%, with periodic
    recovery-week drops.
  - Use the athlete's current race-pace ability (VDOT / predicted times) to
    judge whether the stated goal is realistic and to shape phase emphasis. Do
    NOT invent paces — paces are computed later.
  - Use current fitness (CTL/ATL/form) to gauge fatigue vs freshness when
    placing recovery weeks and the early ramp.
  - Treat any ACTIVE injury/illness as a HARD CONSTRAINT: reduce loading and
    add a short accommodation note in the notes of the affected weeks.
  - Use taper/race phases only in the final weeks, and only when a race anchors
    the plan.
  - Do NOT output paces, heart-rate targets, or per-session structure — only
    weekly intent and key-session labels.`;

  return invokeStructured(PlanMacroSchema, prompt, "propose macro plan", model);
}
