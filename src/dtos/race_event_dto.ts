import type { z } from "zod";
import type { RaceEventDao } from "../repositories/race_event_repository";
import type { DeleteRaceEventResponseSchema, RaceEventSchema } from "../schemas/api_schemas";

export type RaceEventDto = z.infer<typeof RaceEventSchema>;
export type DeleteRaceEventDto = z.infer<typeof DeleteRaceEventResponseSchema>;

export function toRaceEventDto(dao: RaceEventDao): RaceEventDto {
  return {
    id: dao.id,
    name: dao.name,
    date: dao.date,
    distanceMeters: dao.distanceMeters,
    targetTimeSeconds: dao.targetTimeSeconds,
    priority: dao.priority,
    status: dao.status,
    createdAt: dao.createdAt.toISOString(),
    updatedAt: dao.updatedAt.toISOString(),
  };
}
