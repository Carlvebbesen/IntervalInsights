import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { CoachCtx, CoachTool } from "../../training/tool_types";
import { brainTools } from "../../training/tools/brain";
import { type IntakeDraft, IntakeDraftSchema } from "./intake_state";

function getCtx(config: LangGraphRunnableConfig<CoachCtx> | undefined): CoachCtx {
  const ctx = config?.context;
  if (!ctx) throw new Error("Intake context missing from runtime");
  return ctx;
}

function toolCallId(config: unknown): string {
  return (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ?? "";
}

const updatePlanDraft = tool(
  async (input, config) =>
    new Command({
      update: {
        draft: input as IntakeDraft,
        messages: [
          new ToolMessage({
            tool_call_id: toolCallId(config),
            content: JSON.stringify({ saved: input }),
          }),
        ],
      },
    }),
  {
    name: "update_plan_draft",
    description:
      "Save structured plan settings the athlete just revealed. Call it the moment a setting comes up in conversation — pass only the fields that changed; they merge into the running draft.",
    schema: IntakeDraftSchema,
  },
);

const finalizeIntake = tool(
  async (input: { athleteBrief: string }, config) =>
    new Command({
      update: {
        ready: true,
        athleteBrief: input.athleteBrief,
        messages: [
          new ToolMessage({
            tool_call_id: toolCallId(config),
            content: "Intake finalized. Tell the athlete the plan builder is ready to start.",
          }),
        ],
      },
    }),
  {
    name: "finalize_intake",
    description:
      "Mark the intake complete once goal, timeframe, and days per week are known. The brief is handed verbatim to the plan-building coach.",
    schema: z.object({
      athleteBrief: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "compact coach-to-coach summary of everything relevant that is NOT in the structured draft fields: injury story, training history, preferences, motivations, method preference",
        ),
    }),
  },
);

// The two knowledge-base CoachTools, adapted to plain LangChain tools so the
// ToolNode can run them; the CoachCtx rides in on the runtime context.
function adaptCoachTool(coachTool: CoachTool) {
  return tool(
    async (input, config) => {
      const ctx = getCtx(config as LangGraphRunnableConfig<CoachCtx>);
      return JSON.stringify(await coachTool.handler(ctx, input as Record<string, unknown>));
    },
    {
      name: coachTool.name,
      description: coachTool.description,
      schema: coachTool.params,
    },
  );
}

export const intakeTools = [...brainTools.map(adaptCoachTool), updatePlanDraft, finalizeIntake];
