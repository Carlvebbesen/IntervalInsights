// Small factories for inserting common test rows under a given test user.

import { activityEvents, activities, events } from "../../src/schema";
import { getDb } from "./db";

export type SeededActivity = {
  id: number;
  stravaActivityId: number;
};

export async function insertActivity(
  userId: string,
  overrides: Partial<{
    title: string;
    stravaActivityId: number;
    sportType: string;
    distance: number;
    movingTime: number;
    startDateLocal: Date;
    analysisStatus:
      | "pending"
      | "ongoing_init"
      | "initial"
      | "ongoing_completed"
      | "completed"
      | "error"
      | "skipped_inactive";
    trainingType:
      | "LONG"
      | "EASY"
      | "RECOVERY"
      | "SHORT_INTERVALS"
      | "HILL_SPRINTS"
      | "LONG_INTERVALS"
      | "SPRINTS"
      | "FARTLEK"
      | "PROGRESSIVE_LONG"
      | "RACE"
      | "TEMPO"
      | "OTHER"
      | null;
    indoor: boolean;
    description: string | null;
    notes: string | null;
    feeling: number | null;
    gearId: string | null;
  }> = {},
): Promise<SeededActivity> {
  const db = getDb();
  const [row] = await db
    .insert(activities)
    .values({
      userId,
      stravaActivityId:
        overrides.stravaActivityId ?? Math.floor(Math.random() * 1e12),
      title: overrides.title ?? "Test Run",
      sportType: overrides.sportType ?? "Run",
      distance: overrides.distance ?? 5000,
      movingTime: overrides.movingTime ?? 1500,
      startDateLocal: overrides.startDateLocal ?? new Date(),
      analysisStatus: overrides.analysisStatus ?? "completed",
      trainingType: overrides.trainingType ?? "EASY",
      indoor: overrides.indoor ?? false,
      description: overrides.description ?? null,
      notes: overrides.notes ?? null,
      feeling: overrides.feeling ?? null,
      gearId: overrides.gearId ?? null,
    })
    .returning();
  return { id: row.id, stravaActivityId: row.stravaActivityId };
}

export async function insertEvent(
  userId: string,
  overrides: Partial<{
    eventType: "INJURY" | "ILLNESS" | "MEDICAL_VISIT" | "PHYSIO_VISIT" | "OTHER";
    bodyLocation: string | null;
    description: string;
    startTime: Date;
    lastOccurrence: Date;
    status: "active" | "resolved";
  }> = {},
) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .insert(events)
    .values({
      userId,
      eventType: overrides.eventType ?? "INJURY",
      bodyLocation: overrides.bodyLocation ?? null,
      description: overrides.description ?? "Test event",
      startTime: overrides.startTime ?? now,
      lastOccurrence: overrides.lastOccurrence ?? now,
      status: overrides.status ?? "active",
    })
    .returning();
  return row;
}

export async function linkEventToActivity(activityId: number, eventId: number) {
  const db = getDb();
  await db
    .insert(activityEvents)
    .values({ activityId, eventId })
    .onConflictDoNothing();
}
