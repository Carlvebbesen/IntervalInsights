// Small factories for inserting common test rows under a given test user.

import {
  activities,
  activityEvents,
  events,
  intervalStructures,
  plannedSessions,
  raceEvents,
  trainingPlans,
  trainingPlanWeeks,
} from "../../src/schema";
import type { WorkoutStructureSet } from "../../src/schemas/agent_schemas";
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
    localGearId: number | null;
    gearUpdatedFromStrava: boolean;
    intervalStructureId: number | null;
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
      localGearId: overrides.localGearId ?? null,
      gearUpdatedFromStrava: overrides.gearUpdatedFromStrava ?? false,
      intervalStructureId: overrides.intervalStructureId ?? null,
    })
    .returning();
  return { id: row.id, stravaActivityId: row.stravaActivityId as number };
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

// Global table (no userId) — delete by id in the test's afterAll.
export async function insertIntervalStructure(
  overrides: Partial<{
    name: string;
    signature: string | null;
    trainingType: "SHORT_INTERVALS" | "LONG_INTERVALS" | "TEMPO" | "FARTLEK";
  }> = {},
) {
  const db = getDb();
  const [row] = await db
    .insert(intervalStructures)
    .values({
      name: overrides.name ?? "10x1000m",
      signature: overrides.signature ?? `test-sig-${Math.random().toString(36).slice(2)}`,
      trainingType: overrides.trainingType ?? "LONG_INTERVALS",
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

export async function insertRaceEvent(
  userId: string,
  overrides: Partial<{
    name: string;
    date: string;
    distanceMeters: number;
    targetTimeSeconds: number | null;
    priority: "A" | "B" | "C";
    status: "upcoming" | "completed" | "cancelled";
  }> = {},
) {
  const db = getDb();
  const [row] = await db
    .insert(raceEvents)
    .values({
      userId,
      name: overrides.name ?? "Test Race",
      date: overrides.date ?? "2026-12-01",
      distanceMeters: overrides.distanceMeters ?? 10000,
      targetTimeSeconds: overrides.targetTimeSeconds ?? null,
      priority: overrides.priority ?? "A",
      status: overrides.status ?? "upcoming",
    })
    .returning();
  return row;
}

export async function insertTrainingPlan(
  userId: string,
  overrides: Partial<{
    name: string;
    startDate: string;
    endDate: string;
    raceEventId: number | null;
    goalText: string | null;
    status: "draft" | "active" | "completed" | "archived";
  }> = {},
) {
  const db = getDb();
  const [row] = await db
    .insert(trainingPlans)
    .values({
      userId,
      name: overrides.name ?? "Test Plan",
      startDate: overrides.startDate ?? "2026-01-01",
      endDate: overrides.endDate ?? "2026-03-01",
      raceEventId: overrides.raceEventId ?? null,
      goalText: overrides.goalText ?? null,
      status: overrides.status ?? "draft",
    })
    .returning();
  return row;
}

export async function insertTrainingPlanWeek(
  planId: number,
  overrides: Partial<{
    weekIndex: number;
    startDate: string;
    phase: "base" | "build" | "peak" | "taper" | "race" | null;
    targetDistanceMeters: number | null;
    targetLoad: number | null;
    notes: string | null;
  }> = {},
) {
  const db = getDb();
  const [row] = await db
    .insert(trainingPlanWeeks)
    .values({
      planId,
      weekIndex: overrides.weekIndex ?? 0,
      startDate: overrides.startDate ?? "2026-01-01",
      phase: overrides.phase ?? null,
      targetDistanceMeters: overrides.targetDistanceMeters ?? null,
      targetLoad: overrides.targetLoad ?? null,
      notes: overrides.notes ?? null,
    })
    .returning();
  return row;
}

export async function insertPlannedSession(
  planId: number,
  weekId: number,
  overrides: Partial<{
    date: string;
    sessionType:
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
      | "OTHER";
    title: string;
    description: string | null;
    structure: WorkoutStructureSet[] | null;
    status: "planned" | "completed" | "skipped" | "moved";
    sortOrder: number;
  }> = {},
) {
  const db = getDb();
  const [row] = await db
    .insert(plannedSessions)
    .values({
      planId,
      weekId,
      date: overrides.date ?? "2026-01-02",
      sessionType: overrides.sessionType ?? "EASY",
      title: overrides.title ?? "Test Session",
      description: overrides.description ?? null,
      structure: overrides.structure ?? null,
      status: overrides.status ?? "planned",
      sortOrder: overrides.sortOrder ?? 0,
    })
    .returning();
  return row;
}
