import type { z } from "zod";
import { AppError, IntervalsError, StravaError } from "../../error";
import { type CoachCtx, type CoachTool, isToolAvailable } from "./tool_types";
import { activityTools } from "./tools/activities";
import { analyticsTools } from "./tools/analytics";
import { brainTools } from "./tools/brain";
import { curveTools } from "./tools/curves";
import { dashboardTools } from "./tools/dashboard";
import { eventTools } from "./tools/events";
import { fitnessTools } from "./tools/fitness";
import { profileTools } from "./tools/profile";
import { segmentTools } from "./tools/segments";
import { streamTools } from "./tools/streams";
import { structureTools } from "./tools/structures";
import { suggestTools } from "./tools/suggest";
import { trainingPlanTools } from "./tools/training_plans";

export const registry: CoachTool[] = [
  ...activityTools,
  ...segmentTools,
  ...streamTools,
  ...eventTools,
  ...structureTools,
  ...dashboardTools,
  ...fitnessTools,
  ...analyticsTools,
  ...curveTools,
  ...suggestTools,
  ...profileTools,
  ...brainTools,
  ...trainingPlanTools,
];

interface ParamDescriptor {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  optional: boolean;
  description?: string;
} {
  let s = schema;
  let optional = false;
  let description = schema.description;
  for (;;) {
    const typeName = (s._def as { typeName?: string }).typeName;
    if (typeName === "ZodOptional" || typeName === "ZodDefault") {
      optional = true;
      s = (s._def as { innerType: z.ZodTypeAny }).innerType;
    } else if (typeName === "ZodNullable") {
      s = (s._def as { innerType: z.ZodTypeAny }).innerType;
    } else {
      break;
    }
    if (!description) description = s.description;
  }
  return { inner: s, optional, description };
}

function typeLabel(s: z.ZodTypeAny): string {
  const def = s._def as { typeName?: string; values?: string[]; type?: z.ZodTypeAny };
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return `enum(${(def.values ?? []).join("|")})`;
    case "ZodArray":
      return def.type ? `${typeLabel(def.type)}[]` : "array";
    case "ZodObject":
      return "object";
    default:
      return def.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
  }
}

function describeParams(params: CoachTool["params"]): ParamDescriptor[] {
  return Object.entries(params.shape).map(([name, field]) => {
    const { inner, optional, description } = unwrap(field as z.ZodTypeAny);
    return { name, type: typeLabel(inner), required: !optional, description };
  });
}

export interface ToolDescriptor {
  name: string;
  description: string;
  requires: CoachTool["requires"];
  parameters: ParamDescriptor[];
}

function toDescriptor(tool: CoachTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    requires: tool.requires,
    parameters: describeParams(tool.params),
  };
}

const MAX_FIND_RESULTS = 8;

export function findTools(query: string, ctx: CoachCtx): ToolDescriptor[] {
  const available = registry.filter((t) => isToolAvailable(t, ctx));
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (terms.length === 0) return available.slice(0, MAX_FIND_RESULTS).map(toDescriptor);

  const scored = available
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const kw = tool.keywords.join(" ").toLowerCase();
      const desc = tool.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        if (kw.includes(term)) score += 2;
        if (desc.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const matches = scored.length > 0 ? scored.map((s) => s.tool) : available;
  return matches.slice(0, MAX_FIND_RESULTS).map(toDescriptor);
}

export type ToolWriter = (chunk: unknown) => void;

export interface ToolRunResult {
  data?: unknown;
  error?: string;
  issues?: { path: string; message: string }[];
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CoachCtx,
  writer?: ToolWriter,
): Promise<ToolRunResult> {
  const tool = registry.find((t) => t.name === name);
  if (!tool) {
    return { error: `Unknown tool "${name}". Call find_tools to discover valid tool names.` };
  }
  if (!isToolAvailable(tool, ctx)) {
    return {
      error: `Tool "${name}" needs a linked intervals.icu account, which this user does not have. Tell the user they can connect intervals.icu to unlock fitness/wellness data.`,
    };
  }

  const parsed = tool.params.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      error: `Invalid arguments for "${name}".`,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }

  writer?.({ phase: "tool", tool: name, status: "running" });
  try {
    const data = await tool.handler(ctx, parsed.data);
    writer?.({ phase: "tool", tool: name, status: "done" });
    return { data };
  } catch (err) {
    ctx.logger.error({ err, tool: name }, "coach tool failed");
    writer?.({ phase: "tool", tool: name, status: "error" });
    if (err instanceof AppError) return { error: err.message };
    if (err instanceof StravaError) return { error: "Strava data could not be fetched right now." };
    if (err instanceof IntervalsError) {
      return { error: "intervals.icu data could not be fetched right now." };
    }
    return { error: `Tool "${name}" failed to execute.` };
  }
}

export function toolCatalogForPrompt(): string {
  return registry
    .map(
      (t) => `- ${t.name}${t.requires === "intervals" ? " [intervals.icu]" : ""}: ${t.description}`,
    )
    .join("\n");
}
