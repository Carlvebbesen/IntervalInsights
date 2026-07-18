import { type AIMessage, isAIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { logger } from "../../../logger";
import type { CoachArtifact } from "../../../schemas/api_schemas";
import { invokeStructured, isRateLimitError } from "../../model";
import type { TrainingState, TrainingUpdate } from "../graph_state";
import { buildVerifyPrompt, SAFE_REFUSAL } from "../prompts";

const MAX_VERIFY_ATTEMPTS = 1;

const verifySchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
  feedback: z.string(),
});

function summarizeArtifacts(artifacts: CoachArtifact[]): string {
  return artifacts
    .map((a) => {
      switch (a.type) {
        case "proposed_training": {
          const reps = a.structure.reduce(
            (n, s) => n + s.set_reps * s.steps.reduce((m, st) => m + st.reps, 0),
            0,
          );
          const hasPaces = a.structure.some((s) => s.steps.some((st) => st.target_pace != null));
          return `workout "${a.title}" (${hasPaces ? "with paces" : "structure only"}, ${reps} reps)`;
        }
        case "chart": {
          const points = a.series.reduce((n, s) => n + s.points.length, 0);
          return `chart "${a.title}" (${a.chartType}, ${a.series.length} series, ${points} points)`;
        }
        case "table":
          return `table "${a.title ?? "untitled"}" (${a.columns.length} cols × ${a.rows.length} rows)`;
        case "stat_cards":
          return `stat cards "${a.title ?? "untitled"}": ${a.cards
            .map((c) => `${c.label}=${c.value}${c.unit ?? ""}`)
            .join(", ")}`;
        case "weekly_plan":
          return `weekly plan "${a.title}" (${a.days.length} days)`;
        case "plan_revision":
          return `plan revision "${a.title}" (${a.changes.length} changes, not yet applied)`;
        default:
          return "card";
      }
    })
    .join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export async function verifyNode(state: TrainingState): Promise<TrainingUpdate> {
  const lastAi = [...state.messages].reverse().find((m) => isAIMessage(m)) as AIMessage | undefined;
  const candidate = textOf(lastAi?.content).trim();
  const lastHuman = [...state.messages].reverse().find((m) => m.getType() === "human");
  const question = textOf(lastHuman?.content);

  const artifacts = state.pendingArtifacts ?? [];
  const verdict = await invokeStructured(
    verifySchema,
    buildVerifyPrompt(question, candidate, summarizeArtifacts(artifacts)),
    "verify coach answer",
  ).catch((err) => (isRateLimitError(err) ? null : Promise.reject(err)));

  if (!verdict) {
    logger.warn("coach verify node: verifier returned null, passing draft through");
    return { finalAnswer: candidate || SAFE_REFUSAL, verdict: "pass" };
  }

  if (verdict.pass) {
    return { finalAnswer: candidate || SAFE_REFUSAL, verdict: "pass" };
  }

  if (state.verifyAttempts < MAX_VERIFY_ATTEMPTS) {
    logger.info({ reason: verdict.reason }, "coach verify node: requesting regeneration");
    return {
      verdict: "regenerate",
      verifyFeedback: verdict.feedback,
      verifyAttempts: state.verifyAttempts + 1,
      pendingArtifacts: null,
    };
  }

  logger.warn({ reason: verdict.reason }, "coach verify node: blocked after retry, safe refusal");
  return { finalAnswer: SAFE_REFUSAL, verdict: "blocked", blocked: true, pendingArtifacts: null };
}
