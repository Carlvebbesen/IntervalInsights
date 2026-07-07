import "zod-openapi/extend";
import { z } from "zod";

export const IntervalStructureSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    signature: z.string().nullable(),
  })
  .openapi({ ref: "IntervalStructure" });

export const IntervalStructureListItemSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    signature: z.string().nullable(),
    activityCount: z.number(),
    lastDoneAt: z.string().nullable(),
  })
  .openapi({ ref: "IntervalStructureListItem" });

export const IntervalStructureListResponseSchema = z
  .object({
    data: z.array(IntervalStructureListItemSchema),
    meta: z.object({ count: z.number() }),
  })
  .openapi({ ref: "IntervalStructureListResponse" });

export const IntervalStructureHistoryEntrySchema = z
  .object({
    activityId: z.number(),
    date: z.string(),
    title: z.string(),
    indoor: z.boolean(),
    distance: z.number(),
    movingTime: z.number(),
    avgHeartRate: z.number().nullable(),
    load: z.number().nullable(),
    workRepCount: z.number(),
    avgWorkPaceSecPerKm: z.number().nullable(),
    fastestWorkPaceSecPerKm: z.number().nullable(),
    slowestWorkPaceSecPerKm: z.number().nullable(),
    targetWorkPaceSecPerKm: z.number().nullable(),
    avgWorkHr: z.number().nullable(),
    minWorkHr: z.number().nullable(),
    maxWorkHr: z.number().nullable(),
  })
  .openapi({ ref: "IntervalStructureHistoryEntry" });

export const IntervalStructureHistoryResponseSchema = z
  .object({
    data: z.array(IntervalStructureHistoryEntrySchema),
    meta: z.object({ structureId: z.number(), count: z.number() }),
  })
  .openapi({ ref: "IntervalStructureHistoryResponse" });
