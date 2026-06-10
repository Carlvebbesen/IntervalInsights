import { z } from "zod";
import * as structureRepo from "../../../repositories/interval_structure_repository";
import { defineTool } from "../tool_types";

const listIntervalStructures = defineTool({
  name: "list_interval_structures",
  description:
    "The distinct interval workout shapes the user has done (e.g. '6x800m', '4x(3min/2min)'), each with an id, name, signature, how many times it's been done (activityCount) and when last done. Ordered most-recent first. Use to find repeated sessions, then get_structure_history to see progression.",
  keywords: ["structures", "interval", "workout shapes", "signatures", "repeated", "templates"],
  requires: "db",
  params: z.object({}),
  handler: (ctx) => structureRepo.listDistinctForUser(ctx.db, ctx.userId),
});

const getStructureHistory = defineTool({
  name: "get_structure_history",
  description:
    "Every session of one repeated interval structure over time (oldest → newest), each with date, distance, load, avg HR and a work-rep summary (count, average work pace in sec/km, average work HR). Use to show how a recurring workout (e.g. 6x800m) has progressed. Get the structureId from list_interval_structures.",
  keywords: ["progression", "history", "compare", "over time", "structure", "repeated", "trend"],
  requires: "db",
  params: z.object({
    structureId: z.number().int().describe("id from list_interval_structures"),
  }),
  handler: (ctx, args) => structureRepo.structureHistory(ctx.db, ctx.userId, args.structureId),
});

export const structureTools = [listIntervalStructures, getStructureHistory];
