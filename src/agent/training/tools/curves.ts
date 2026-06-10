import { z } from "zod";
import { fetchBestEffortCurve } from "../../../services/intervals_curve_service";
import { defineTool } from "../tool_types";

const getBestEffortCurve = defineTool({
  name: "get_best_effort_curve",
  description:
    "Best-effort / power-pace curve from intervals.icu: the best value the athlete sustained for each standard duration (5s → 90m) over a window. Use for personal-best efforts, peak power/pace, critical-speed/critical-power and fitness-peak questions. For runs the value is running power or pace where available; for rides it's watts.",
  keywords: [
    "best effort",
    "power curve",
    "pace curve",
    "critical power",
    "critical speed",
    "peak",
    "pr",
    "personal best",
    "fastest",
    "mmp",
    "watts",
  ],
  requires: "intervals",
  params: z.object({
    type: z
      .string()
      .optional()
      .describe("activity type, e.g. 'Run','TrailRun','Ride'. Defaults to 'Run'."),
    window: z
      .enum(["this_season", "last_season", "custom"])
      .optional()
      .describe("defaults to 'this_season'. Use 'custom' with oldest+newest."),
    oldest: z.string().optional().describe("ISO date; required when window='custom'"),
    newest: z.string().optional().describe("ISO date; required when window='custom'"),
  }),
  handler: (ctx, args) =>
    fetchBestEffortCurve(ctx.clerkUserId, {
      type: args.type,
      window: args.window,
      oldest: args.oldest,
      newest: args.newest,
    }),
});

export const curveTools = [getBestEffortCurve];
