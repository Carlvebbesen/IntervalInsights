import "zod-openapi/extend";
import { z } from "zod";
import { raceEventStatusEnum, racePriorityEnum } from "../schema/enums";

// Shared INPUT shapes: the REST router and the coach/MCP tools validate the
// very same fields, so they must come from one place.
export const CreateRaceEventInputSchema = z.object({
  name: z.string().min(1),
  date: z.string().date(),
  distanceMeters: z.number().int().positive(),
  targetTimeSeconds: z.number().int().positive().optional(),
  priority: z.enum(racePriorityEnum.enumValues).optional(),
  status: z.enum(raceEventStatusEnum.enumValues).optional(),
});

export const UpdateRaceEventInputSchema = z.object({
  name: z.string().min(1).optional(),
  date: z.string().date().optional(),
  distanceMeters: z.number().int().positive().optional(),
  targetTimeSeconds: z.number().int().positive().nullable().optional(),
  priority: z.enum(racePriorityEnum.enumValues).optional(),
  status: z.enum(raceEventStatusEnum.enumValues).optional(),
});

export const RaceEventSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    date: z.string(),
    distanceMeters: z.number(),
    targetTimeSeconds: z.number().nullable(),
    priority: z.enum(racePriorityEnum.enumValues),
    status: z.enum(raceEventStatusEnum.enumValues),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "RaceEvent" });

export const RaceEventListResponseSchema = z
  .object({
    data: z.array(RaceEventSchema),
  })
  .openapi({ ref: "RaceEventListResponse" });

export const DeleteRaceEventResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .openapi({ ref: "DeleteRaceEventResponse" });
