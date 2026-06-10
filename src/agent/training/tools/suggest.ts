import { z } from "zod";
import { trainingTypeEnum } from "../../../schema/enums";
import { getProposedPaceForStructure } from "../../../services/pace_service";
import { workoutSet } from "../../initial_analysis_agent";
import { invokeParseIntervalsAgent } from "../../parse_intervals_agent";
import { defineTool } from "../tool_types";

const proposePaces = defineTool({
  name: "propose_paces",
  description:
    "Given a structured workout (sets/steps in METERS and SECONDS), return target paces for each rep, interpolated from the user's own recent history of matching sessions. Use when suggesting a new interval session so the paces are personalised. Read-only — nothing is saved.",
  keywords: ["pace", "paces", "target", "suggest", "prescribe", "interval", "propose", "plan"],
  requires: "db",
  params: z.object({
    sets: z
      .array(workoutSet)
      .describe("Workout sets. 6x800m = 1 set, set_reps 1, one step reps 6."),
  }),
  handler: (ctx, args) =>
    getProposedPaceForStructure(ctx.db, ctx.userId, ctx.clerkUserId, args.sets),
});

const parseWorkout = defineTool({
  name: "parse_workout",
  description:
    "Convert a free-text workout description (e.g. '6x800m @ 3:45 with 90s rest') into structured sets/steps (METERS + SECONDS). Pair with propose_paces to fill personalised paces.",
  keywords: ["parse", "workout", "free text", "describe", "structure", "convert"],
  requires: "db",
  params: z.object({
    text: z.string().min(3).max(2000),
    trainingType: z.enum(trainingTypeEnum.enumValues).optional(),
  }),
  handler: (_ctx, args) => invokeParseIntervalsAgent(args.text, args.trainingType ?? null),
});

export const suggestTools = [proposePaces, parseWorkout];
