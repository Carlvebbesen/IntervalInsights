import "zod-openapi/extend";
import { z } from "zod";
import { raceEventStatusEnum, racePriorityEnum } from "../schema/enums";

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
