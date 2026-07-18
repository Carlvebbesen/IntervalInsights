import type { ChatOpenAI } from "@langchain/openai";
import { getPlanBuilderModel, invokeStructured } from "../model";
import { type PlanMacro, PlanMacroSchema } from "./plan_builder_schemas";
import type { AthleteContext, PlanBuilderInput } from "./plan_builder_state";

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
    ? `CTL ${ctx.fitness.ctl ?? "-"}, ATL ${ctx.fitness.atl ?? "-"}, TSB ${ctx.fitness.tsb ?? "-"}, ramp ${ctx.fitness.rampRate ?? "-"}`
    : "not connected";
  return `
  - Athlete: ${ctx.athleteName ?? "unknown"}
  - Max HR: ${ctx.maxHeartRate ?? "unknown"}
  - Fitness (intervals.icu): ${fitness}
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
  - Ramp volume gradually; avoid week-over-week jumps beyond ~20%, with periodic
    recovery-week drops.
  - Use taper/race phases only in the final weeks, and only when a race anchors
    the plan.
  - Do NOT output paces, heart-rate targets, or per-session structure — only
    weekly intent and key-session labels.`;

  return invokeStructured(PlanMacroSchema, prompt, "propose macro plan", model);
}
