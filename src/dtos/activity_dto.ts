import type { z } from "zod";
import type { ActivityDao, ActivityListRow } from "../repositories/activity_repository";
import type { ActivityListItemSchema, ActivitySchema } from "../schemas/api_schemas";
import type { ActivityEventDto } from "./event_dto";
import type { GearSummaryDto } from "./gear_dto";

export type ActivityDto = z.infer<typeof ActivitySchema>;
export type ActivityListItemDto = z.infer<typeof ActivityListItemSchema>;

const iso = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

export function toActivityDto(
  dao: ActivityDao,
  events?: ActivityEventDto[],
  gear?: GearSummaryDto | null,
): ActivityDto {
  return {
    ...dao,
    analyzedAt: iso(dao.analyzedAt),
    startDateLocal: dao.startDateLocal.toISOString(),
    createdAt: iso(dao.createdAt),
    intervalsIcuEnrichedAt: iso(dao.intervalsIcuEnrichedAt),
    events,
    gear: gear ?? null,
  };
}

export function toActivityListItemDto(row: ActivityListRow): ActivityListItemDto {
  return {
    id: row.id,
    title: row.title,
    startDateLocal: row.startDateLocal.toISOString(),
    distance: row.distance,
    sportType: row.sportType,
    indoor: row.indoor,
    trainingType: row.trainingType,
    trainingLoad: row.trainingLoad,
    icuTrainingLoad: row.icuTrainingLoad,
    averageHeartRate: row.averageHeartRate,
  };
}
