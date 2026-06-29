import { z } from "zod";
import type { ReadinessSignals } from "../services/pace_service";
import { trainingTypeEnum } from "../schema/enums";
import { workoutSet } from "./initial_analysis_agent";
import { gptStrongModel, invokeStructured } from "./model";
import { venuePromptBlock } from "./running_venues";

export const suggestSessionOutput = z.object({
  title: z.string().describe("Short workout name, e.g. '6x800m threshold'."),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  notes: z
    .string()
    .describe(
      "One or two short coaching sentences: why this session fits today's readiness and recent history. No invented numbers.",
    ),
  structure: z
    .array(workoutSet)
    .describe(
      "The recommended session as workout sets. 6x800m = one set, set_reps 1, one step reps 6.",
    ),
});

export type SuggestSessionOutput = z.infer<typeof suggestSessionOutput>;

export type SuggestionMode = "signature" | "recommended";

export interface SuggestSessionContext {
  date: string;
  baseStructure: z.infer<typeof workoutSet>[];
  structureName: string | null;
  historySummary: string;
  readiness: ReadinessSignals;
  advisory: string;
  mode: SuggestionMode;
}

function readinessBlock(r: ReadinessSignals): string {
  const fmt = (v: number | null, digits = 0) => (v == null ? "n/a" : v.toFixed(digits));
  return [
    `- CTL (fitness): ${fmt(r.ctl, 1)}`,
    `- ATL (fatigue): ${fmt(r.atl, 1)}`,
    `- TSB (form): ${fmt(r.tsb, 1)}`,
    `- Ramp rate: ${fmt(r.ramp, 1)}`,
    `- HRV status: ${r.hrvStatus ?? "n/a"}`,
    `- Sleep score: ${fmt(r.sleepScore, 0)}`,
  ].join("\n");
}

export async function invokeSuggestSessionAgent(
  ctx: SuggestSessionContext,
): Promise<SuggestSessionOutput | null> {
  const commonRules = `- Keep distance in METERS and time in SECONDS, with recovery between reps.
- Do NOT output target paces or any specific pace numbers — paces are computed separately from the athlete's history.
- 'notes': 1-2 short coaching sentences explaining why this session fits today (reference the readiness signals and/or recent history in plain language; never invent numbers).
- Classify 'trainingType' from the enum based on the per-rep work size (a rep ≥ 120s OR ≥ 800m is LONG_INTERVALS; shorter is SHORT_INTERVALS).`;

  const prompt =
    ctx.mode === "recommended"
      ? `
You are an expert endurance-running coach. Recommend the single interval session that best serves THIS athlete TODAY, driven by their recent interval training and today's readiness. This is a free recommendation — you are NOT filling in a template.

### THEIR RECENT INTERVAL TRAINING
${ctx.historySummary || "(no recent interval training on record)"}
${ctx.structureName ? `\n(The athlete currently has "${ctx.structureName}" open on screen — this is context only, NOT a session to reproduce.)\n` : ""}
### TODAY'S READINESS (${ctx.date})
${readinessBlock(ctx.readiness)}
${ctx.advisory ? `\nReadiness note already shown to the athlete: "${ctx.advisory}"` : ""}

### HOW TO DECIDE
- Do NOT default to repeating the session they have open or the one they did most recently. Pick what their training actually needs now.
- Choose the workout type deliberately: short vs long intervals, threshold vs VO2max-style, total volume, and recovery — based on what is MISSING from their recent training and what today's readiness supports.
- Poor readiness (low/negative TSB, high ATL, poor HRV/sleep) → fewer reps, shorter or easier work, longer recovery. Good form → a harder or longer quality session.
- It is fine — often better — to recommend a session that differs from what's shown. You may design one they haven't done recently, as long as it is a sensible, runnable interval workout.

### RULES
${commonRules}

${venuePromptBlock()}

### TASK
Return the recommended session structure, a short title, the training type, and the coaching notes (say in one line why this session over their usual).
`
      : `
You are an expert endurance-running coach. The athlete wants you to suggest a structured interval session for a specific day, based on a workout shape they have in mind, their own recent history of that session, and today's readiness signals.

### THE SESSION SHAPE THE ATHLETE PICKED
${ctx.structureName ? `Name: ${ctx.structureName}\n` : ""}Structure (sets/steps in METERS and SECONDS):
${JSON.stringify(ctx.baseStructure)}

### THEIR RECENT HISTORY OF THIS SESSION
${ctx.historySummary || "(no recent history of this exact session)"}

### TODAY'S READINESS (${ctx.date})
${readinessBlock(ctx.readiness)}
${ctx.advisory ? `\nReadiness note already shown to the athlete: "${ctx.advisory}"` : ""}

### RULES
- Stay close to the shape the athlete picked. You MAY adjust the rep count or recovery modestly (e.g. drop a rep, lengthen recovery) when today's readiness is poor — but do NOT invent a completely different workout.
${commonRules}

${venuePromptBlock()}

### TASK
Return the recommended session structure, a short title, the training type, and the coaching notes.
`;

  // Recommended mode is open-ended coaching judgment — mini tends to echo the
  // shown structure, so use the stronger tier. Signature mode (constrained
  // reshaping) stays on the default mini.
  return invokeStructured(
    suggestSessionOutput,
    prompt,
    "suggest today's session",
    ctx.mode === "recommended" ? gptStrongModel : undefined,
  );
}
