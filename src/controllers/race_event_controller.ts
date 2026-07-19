import { type RaceEventDto, toRaceEventDto } from "../dtos/race_event_dto";
import { AppError } from "../error";
import * as raceEventRepo from "../repositories/race_event_repository";
import type { InsertRaceEvent, RaceEventStatus, RacePriority } from "../schema";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export async function listRaceEvents(
  db: Db,
  userId: string,
  filters: { status?: RaceEventStatus },
): Promise<RaceEventDto[]> {
  const rows = await raceEventRepo.listForUser(db, userId, filters);
  return rows.map(toRaceEventDto);
}

export interface CreateRaceEventInput {
  name: string;
  date: string;
  distanceMeters: number;
  targetTimeSeconds?: number;
  priority?: RacePriority;
  status?: RaceEventStatus;
}

export async function createRaceEvent(
  db: Db,
  userId: string,
  input: CreateRaceEventInput,
): Promise<RaceEventDto> {
  const values: Omit<InsertRaceEvent, "userId"> = {
    name: input.name,
    date: input.date,
    distanceMeters: input.distanceMeters,
    targetTimeSeconds: input.targetTimeSeconds ?? null,
    priority: input.priority ?? "B",
    status: input.status ?? "upcoming",
  };
  const created = await raceEventRepo.createForUser(db, userId, values);
  return toRaceEventDto(created);
}

export interface UpdateRaceEventInput {
  name?: string;
  date?: string;
  distanceMeters?: number;
  targetTimeSeconds?: number | null;
  priority?: RacePriority;
  status?: RaceEventStatus;
}

export async function updateRaceEvent(
  db: Db,
  userId: string,
  id: number,
  patch: UpdateRaceEventInput,
): Promise<RaceEventDto> {
  const updates: Partial<InsertRaceEvent> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.date !== undefined) updates.date = patch.date;
  if (patch.distanceMeters !== undefined) updates.distanceMeters = patch.distanceMeters;
  if (patch.targetTimeSeconds !== undefined) updates.targetTimeSeconds = patch.targetTimeSeconds;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.status !== undefined) updates.status = patch.status;

  const updated = await raceEventRepo.updateForUser(db, userId, id, updates);
  if (!updated) throw new AppError(404, "Race event not found or unauthorized");
  return toRaceEventDto(updated);
}

export async function deleteRaceEvent(
  db: Db,
  userId: string,
  id: number,
): Promise<{ success: true }> {
  const found = await raceEventRepo.deleteForUser(db, userId, id);
  if (!found) throw new AppError(404, "Race event not found or unauthorized");
  return { success: true };
}
