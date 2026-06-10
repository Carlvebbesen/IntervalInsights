import { z } from "zod";
import { readBrainPage, searchBrainPages } from "../brain_knowledge";
import { defineTool } from "../tool_types";

const searchKnowledgeBase = defineTool({
  name: "search_knowledge_base",
  description:
    "Search the coach's curated training knowledge base: training methods (Norwegian method, polarized, double threshold), physiology concepts (lactate threshold, VO2max, CTL/ATL), principles, session templates, nutrition and recovery. Use it to ground any training-theory, methodology, 'why', or 'how should I train' answer. Returns matching pages with slug + summary; read the full page with read_knowledge_page. NOT for the athlete's personal data.",
  keywords: [
    "knowledge",
    "theory",
    "method",
    "methodology",
    "norwegian",
    "polarized",
    "threshold",
    "lactate",
    "principle",
    "physiology",
    "nutrition",
    "fueling",
    "recovery",
    "why",
    "science",
    "glossary",
    "concept",
  ],
  requires: "db",
  params: z.object({
    query: z
      .string()
      .describe(
        "keywords for the training topic, e.g. 'double threshold lactate' or 'carbohydrate fueling race'",
      ),
  }),
  handler: (_ctx, args) => searchBrainPages(args.query),
});

const readKnowledgePage = defineTool({
  name: "read_knowledge_page",
  description:
    "Read one full page from the training knowledge base by its slug (from search_knowledge_base results or a [[wikilink]]). Returns the page markdown plus its outgoing links — follow links that look relevant by reading those slugs too. The slug 'index' is the master catalog of every page.",
  keywords: ["knowledge", "page", "read", "wiki", "article", "detail", "index", "catalog"],
  requires: "db",
  params: z.object({
    slug: z.string().describe("page slug, e.g. 'norwegian-method' or 'index'"),
  }),
  handler: (_ctx, args) => readBrainPage(args.slug),
});

export const brainTools = [searchKnowledgeBase, readKnowledgePage];
