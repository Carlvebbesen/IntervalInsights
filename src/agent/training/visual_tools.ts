import { ToolMessage } from "@langchain/core/messages";
import { type ToolRunnableConfig, tool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import { z } from "zod";
import { getProposedPace } from "../../controllers/analysis_controller";
import { AppError } from "../../error";
import { getWithDetailForUser } from "../../repositories/training_plan_repository";
import { trainingTypeEnum } from "../../schema/enums";
import { type PlanRevisionChange, PlanRevisionChangeSchema } from "../../schemas/agent_schemas";
import type { CoachArtifact } from "../../schemas/api_schemas";
import { toWorkoutStructure } from "../../services/workout_structure_format";
import { workoutSet } from "../initial_analysis_agent";
import { stripPaces } from "../planning/guards";
import type { CoachCtx } from "./tool_types";

function getCtx(config: ToolRunnableConfig): CoachCtx {
  const ctx = config.context as CoachCtx | undefined;
  if (!ctx) throw new Error("Coach context missing from runtime");
  return ctx;
}

function renderArtifact(
  config: ToolRunnableConfig,
  artifact: CoachArtifact,
  ack: Record<string, unknown>,
): Command {
  return new Command({
    update: {
      pendingArtifacts: [artifact],
      messages: [
        new ToolMessage({ content: JSON.stringify(ack), tool_call_id: config.toolCall?.id ?? "" }),
      ],
    },
  });
}

function formatPace(mps: number | null | undefined): string | null {
  if (!mps || mps <= 0) return null;
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

export const createTrainingTool = tool(
  async (input, config: ToolRunnableConfig) => {
    const ctx = getCtx(config);
    const includePaces = input.includePaces ?? true;

    const paced = includePaces
      ? await getProposedPace(
          ctx.db,
          ctx.userId,
          ctx.stravaAccessToken,
          input.sets,
          input.activityId,
          ctx.logger,
        )
      : null;
    const structure = toWorkoutStructure(input.sets, paced);

    const artifact: CoachArtifact = {
      type: "proposed_training",
      id: crypto.randomUUID(),
      title: input.title,
      trainingType: input.trainingType ?? null,
      notes: input.notes ?? null,
      structure,
    };

    const paces = structure
      .flatMap((set) => set.steps.map((step) => formatPace(step.target_pace)))
      .filter(Boolean);
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "proposed_training",
      title: input.title,
      hasPaces: paces.length > 0,
      paces,
      note: "Workout card shown to the athlete. Reference the structure (and paces, if any) in your reply.",
    });
  },
  {
    name: "create_training",
    description:
      "Render a suggested workout as a card for the athlete. Pass the structure as sets/steps in METERS and SECONDS (same shape parse_workout returns). Set includePaces=true (default) to personalise target paces from the athlete's history — or pass activityId to derive paces from a specific past session. Set includePaces=false to show structure only. Nothing is saved or sent anywhere; this only SUGGESTS.",
    schema: z
      .object({
        title: z.string().describe("Short workout name, e.g. '6x800m threshold'."),
        sets: z
          .array(workoutSet)
          .describe("Workout sets. 6x800m = 1 set, set_reps 1, one step reps 6."),
        trainingType: z.enum(trainingTypeEnum.enumValues).optional(),
        includePaces: z
          .boolean()
          .optional()
          .describe("Personalise target paces from history. Default true."),
        activityId: z
          .number()
          .optional()
          .describe("Derive actual paces from this specific past activity instead of history."),
        notes: z.string().optional().describe("Optional short coaching note shown on the card."),
      })
      .strict(),
  },
);

export const createChartTool = tool(
  async (input, config: ToolRunnableConfig) => {
    getCtx(config);
    const artifact: CoachArtifact = {
      type: "chart",
      id: crypto.randomUUID(),
      chartType: input.chartType,
      title: input.title,
      xLabel: input.xLabel,
      yLabel: input.yLabel,
      xType: input.xType,
      series: input.series,
    };
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "chart",
      note: "Chart shown to the athlete.",
    });
  },
  {
    name: "create_chart",
    description:
      "Render a chart for the athlete from values you ALREADY fetched with the data tools. Never invent or estimate data points — only plot real numbers you obtained. Good for trends over time (CTL/fitness, weekly volume), pace/HR comparisons, distributions.",
    schema: z
      .object({
        chartType: z.enum(["line", "bar", "area", "scatter"]),
        title: z.string(),
        xLabel: z.string().optional(),
        yLabel: z.string().optional(),
        xType: z
          .enum(["number", "category", "time"])
          .optional()
          .describe("How to treat the x axis: numeric, category labels, or dates/times."),
        series: z
          .array(
            z.object({
              name: z.string().describe("Legend label for this series."),
              points: z
                .array(
                  z.object({
                    x: z
                      .number()
                      .describe(
                        "Numeric x position. For categories/dates use 0,1,2… in order and put the display text in `label`.",
                      ),
                    y: z.number(),
                    label: z
                      .string()
                      .optional()
                      .describe("Optional x-axis tick text, e.g. 'May 28' or an ISO date."),
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
      })
      .strict(),
  },
);

export const createTableTool = tool(
  async (input, config: ToolRunnableConfig) => {
    getCtx(config);
    const artifact: CoachArtifact = {
      type: "table",
      id: crypto.randomUUID(),
      title: input.title,
      columns: input.columns,
      rows: input.rows,
    };
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "table",
      note: "Table shown to the athlete.",
    });
  },
  {
    name: "create_table",
    description:
      "Render a table for the athlete from values you ALREADY fetched with the data tools. Each row is an object keyed by the column `key`s. Use when comparing several sessions/metrics side by side is clearer than prose. Never invent numbers.",
    schema: z
      .object({
        title: z.string().optional(),
        columns: z
          .array(
            z.object({
              key: z.string().describe("Field name used in each row object."),
              label: z.string().describe("Column header shown to the user."),
              align: z.enum(["left", "right", "center"]).optional(),
            }),
          )
          .min(1),
        rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
      })
      .strict(),
  },
);

export const createStatCardsTool = tool(
  async (input, config: ToolRunnableConfig) => {
    getCtx(config);
    const artifact: CoachArtifact = {
      type: "stat_cards",
      id: crypto.randomUUID(),
      title: input.title,
      cards: input.cards,
    };
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "stat_cards",
      note: "Stat cards shown.",
    });
  },
  {
    name: "create_stat_cards",
    description:
      "Render a row of big-number KPI cards (e.g. CTL/ATL/Form, weekly distance, current pace) from values you ALREADY fetched. Each card has a label, value, optional unit, trend arrow and a small caption. Great as a snapshot at the top of a fitness/recovery summary. Never invent numbers.",
    schema: z
      .object({
        title: z.string().optional(),
        cards: z
          .array(
            z.object({
              label: z.string(),
              value: z.union([z.string(), z.number()]),
              unit: z.string().optional(),
              trend: z.enum(["up", "down", "flat"]).optional(),
              hint: z.string().optional().describe("Small caption, e.g. 'vs last week'."),
            }),
          )
          .min(1),
      })
      .strict(),
  },
);

export const createWeeklyPlanTool = tool(
  async (input, config: ToolRunnableConfig) => {
    getCtx(config);
    const artifact: CoachArtifact = {
      type: "weekly_plan",
      id: crypto.randomUUID(),
      title: input.title,
      days: input.days,
    };
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "weekly_plan",
      days: input.days.length,
      note: "Weekly plan shown to the athlete.",
    });
  },
  {
    name: "create_weekly_plan",
    description:
      "Render a Mon–Sun training-week plan, one entry per day (mark rest days with isRest). Use for 'plan my week / next block' requests. For a single detailed interval session prefer create_training. Nothing is saved.",
    schema: z
      .object({
        title: z.string().describe("Plan name, e.g. 'Base week 3'."),
        days: z
          .array(
            z.object({
              day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
              sessionType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
              title: z.string().describe("e.g. '6x800m @ 3:45' or 'Rest'."),
              description: z.string().optional(),
              isRest: z.boolean().optional(),
            }),
          )
          .min(1),
      })
      .strict(),
  },
);

function stripChangeStructures(changes: PlanRevisionChange[]): PlanRevisionChange[] {
  return changes.map((change) => {
    if (change.kind === "update_session" && change.patch.structure) {
      return {
        ...change,
        patch: { ...change.patch, structure: stripPaces(change.patch.structure) },
      };
    }
    if (change.kind === "add_session" && change.session.structure) {
      return {
        ...change,
        session: { ...change.session, structure: stripPaces(change.session.structure) },
      };
    }
    return change;
  });
}

async function assertRevisionReferentialIntegrity(
  ctx: CoachCtx,
  planId: number,
  changes: PlanRevisionChange[],
): Promise<void> {
  const detail = await getWithDetailForUser(ctx.db, ctx.userId, planId);
  if (!detail) throw new AppError(404, "Training plan not found or unauthorized");

  const weekIds = new Set(detail.weeks.map((w) => w.id));
  const sessionIds = new Set(detail.sessions.map((s) => s.id));
  for (const change of changes) {
    if (
      (change.kind === "move_session" ||
        change.kind === "update_session" ||
        change.kind === "drop_session") &&
      !sessionIds.has(change.sessionId)
    ) {
      throw new AppError(400, `Session ${change.sessionId} does not belong to plan ${planId}`);
    }
    if (
      (change.kind === "add_session" || change.kind === "update_week") &&
      !weekIds.has(change.weekId)
    ) {
      throw new AppError(400, `Week ${change.weekId} does not belong to plan ${planId}`);
    }
  }
}

export const createPlanRevisionTool = tool(
  async (input, config: ToolRunnableConfig) => {
    const ctx = getCtx(config);
    await assertRevisionReferentialIntegrity(ctx, input.planId, input.changes);
    const changes = stripChangeStructures(input.changes);

    const artifact: CoachArtifact = {
      type: "plan_revision",
      id: crypto.randomUUID(),
      planId: input.planId,
      title: input.title,
      rationale: input.rationale,
      changes,
    };
    return renderArtifact(config, artifact, {
      ok: true,
      rendered: "plan_revision",
      changeCount: changes.length,
      note: "Plan revision proposal shown to the athlete. Nothing is applied yet — only call apply_plan_revision after the athlete explicitly confirms they want these exact changes made.",
    });
  },
  {
    name: "create_plan_revision",
    description:
      "Render a proposed set of changes to an existing training plan (move/update/drop a session, add a session, or update a week's targets) as a card the athlete reviews. This ONLY shows the proposal — nothing is saved. Validates that the plan and every referenced session/week belong to the athlete before rendering. Per policy, ALWAYS call this before apply_plan_revision, and only call apply_plan_revision afterward once the athlete has explicitly confirmed — never apply a revision silently.",
    schema: z
      .object({
        planId: z.number().int().positive(),
        title: z.string().min(1).describe("Short revision name, e.g. 'Move long run to Sunday'."),
        rationale: z.string().min(1).describe("Coach's reasoning for the athlete."),
        changes: z.array(PlanRevisionChangeSchema).min(1),
      })
      .strict(),
  },
);

export const visualTools = [
  createTrainingTool,
  createChartTool,
  createTableTool,
  createStatCardsTool,
  createWeeklyPlanTool,
  createPlanRevisionTool,
];
