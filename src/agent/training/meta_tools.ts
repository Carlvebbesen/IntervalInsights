import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { runResearch } from "./research_subagent";
import { findTools, runTool } from "./tool_registry";
import type { CoachCtx } from "./tool_types";

function getCtx(config: LangGraphRunnableConfig<CoachCtx> | undefined): CoachCtx {
  const ctx = config?.context;
  if (!ctx) throw new Error("Coach context missing from runtime");
  return ctx;
}

export const findToolsTool = tool(
  async (input: { query: string }, config) => {
    const ctx = getCtx(config as LangGraphRunnableConfig<CoachCtx>);
    return JSON.stringify(findTools(input.query, ctx));
  },
  {
    name: "find_tools",
    description:
      "Search the catalog of read-only data tools by keyword and get their exact parameter schemas. ALWAYS call this before run_tool to learn a tool's parameters. Returns matching tools with name, description and parameters.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "keywords for the data you need, e.g. 'ctl fitness trend' or 'interval segments'",
        ),
    }),
  },
);

export const runToolTool = tool(
  async (input: { name: string; args?: Record<string, unknown> }, config) => {
    const cfg = config as LangGraphRunnableConfig<CoachCtx>;
    const ctx = getCtx(cfg);
    const result = await runTool(input.name, input.args ?? {}, ctx, cfg?.writer);
    return JSON.stringify(result);
  },
  {
    name: "run_tool",
    description:
      "Execute a read-only data tool by name with its arguments (filter parameters only — never a user id). Use find_tools first to get the parameter schema. Returns the tool's JSON result.",
    schema: z.object({
      name: z.string(),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("the tool's filter parameters, matching its schema"),
    }),
  },
);

export const researchTool = tool(
  async (input: { question: string }, config) => {
    const cfg = config as LangGraphRunnableConfig<CoachCtx>;
    const ctx = getCtx(cfg);
    return runResearch(input.question, ctx, cfg?.writer);
  },
  {
    name: "research",
    description:
      "Delegate a focused, multi-step data-gathering sub-question to a lighter research assistant that has the same read-only tools (e.g. 'compare my last 5 threshold sessions'). Returns a concise factual summary so you can focus on the final answer.",
    schema: z.object({ question: z.string().describe("a single, specific data question") }),
  },
);

export const metaTools = [findToolsTool, runToolTool, researchTool];
