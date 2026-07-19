import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { WorkoutStructureSet } from "../schemas/agent_schemas";
import { activities } from "./activities";
import {
  plannedSessionStatusEnum,
  planWeekPhaseEnum,
  raceEventStatusEnum,
  racePriorityEnum,
  trainingPlanStatusEnum,
  trainingTypeEnum,
} from "./enums";
import { users } from "./users";

export const raceEvents = pgTable(
  "race_events",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    name: text("name").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    distanceMeters: integer("distance_meters").notNull(),
    targetTimeSeconds: integer("target_time_seconds"),
    priority: racePriorityEnum("priority").notNull().default("B"),
    status: raceEventStatusEnum("status").notNull().default("upcoming"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("race_events_user_idx").on(table.userId),
    index("race_events_user_date_idx").on(table.userId, table.date),
  ],
);

export const trainingPlans = pgTable(
  "training_plans",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    name: text("name").notNull(),
    status: trainingPlanStatusEnum("status").notNull().default("draft"),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    raceEventId: integer("race_event_id").references(() => raceEvents.id, {
      onDelete: "set null",
    }),
    goalText: text("goal_text"),
    constraintsText: text("constraints_text"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("training_plans_user_idx").on(table.userId),
    index("training_plans_user_status_idx").on(table.userId, table.status),
  ],
);

export const trainingPlanWeeks = pgTable(
  "training_plan_weeks",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id")
      .references(() => trainingPlans.id, { onDelete: "cascade" })
      .notNull(),
    weekIndex: integer("week_index").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    phase: planWeekPhaseEnum("phase"),
    targetDistanceMeters: integer("target_distance_meters"),
    targetLoad: integer("target_load"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("training_plan_weeks_plan_week_idx").on(table.planId, table.weekIndex),
    index("training_plan_weeks_plan_idx").on(table.planId),
  ],
);

export const plannedSessions = pgTable(
  "planned_sessions",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id")
      .references(() => trainingPlans.id, { onDelete: "cascade" })
      .notNull(),
    weekId: integer("week_id")
      .references(() => trainingPlanWeeks.id, { onDelete: "cascade" })
      .notNull(),
    date: date("date", { mode: "string" }).notNull(),
    sessionType: trainingTypeEnum("session_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    structure: jsonb("structure").$type<WorkoutStructureSet[]>(),
    status: plannedSessionStatusEnum("status").notNull().default("planned"),
    completedActivityId: integer("completed_activity_id").references(() => activities.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("planned_sessions_plan_idx").on(table.planId),
    index("planned_sessions_week_idx").on(table.weekId),
    index("planned_sessions_plan_date_idx").on(table.planId, table.date),
    uniqueIndex("planned_sessions_completed_activity_idx").on(table.completedActivityId),
  ],
);

export const raceEventsRelations = relations(raceEvents, ({ one, many }) => ({
  user: one(users, { fields: [raceEvents.userId], references: [users.id] }),
  plans: many(trainingPlans),
}));

export const trainingPlansRelations = relations(trainingPlans, ({ one, many }) => ({
  user: one(users, { fields: [trainingPlans.userId], references: [users.id] }),
  raceEvent: one(raceEvents, {
    fields: [trainingPlans.raceEventId],
    references: [raceEvents.id],
  }),
  weeks: many(trainingPlanWeeks),
  sessions: many(plannedSessions),
}));

export const trainingPlanWeeksRelations = relations(trainingPlanWeeks, ({ one, many }) => ({
  plan: one(trainingPlans, {
    fields: [trainingPlanWeeks.planId],
    references: [trainingPlans.id],
  }),
  sessions: many(plannedSessions),
}));

export const plannedSessionsRelations = relations(plannedSessions, ({ one }) => ({
  plan: one(trainingPlans, {
    fields: [plannedSessions.planId],
    references: [trainingPlans.id],
  }),
  week: one(trainingPlanWeeks, {
    fields: [plannedSessions.weekId],
    references: [trainingPlanWeeks.id],
  }),
  completedActivity: one(activities, {
    fields: [plannedSessions.completedActivityId],
    references: [activities.id],
  }),
}));

export type InsertRaceEvent = InferInsertModel<typeof raceEvents>;
export type InsertTrainingPlan = InferInsertModel<typeof trainingPlans>;
export type InsertTrainingPlanWeek = InferInsertModel<typeof trainingPlanWeeks>;
export type InsertPlannedSession = InferInsertModel<typeof plannedSessions>;
export type SelectRaceEvent = InferSelectModel<typeof raceEvents>;
export type SelectTrainingPlan = InferSelectModel<typeof trainingPlans>;
export type SelectTrainingPlanWeek = InferSelectModel<typeof trainingPlanWeeks>;
export type SelectPlannedSession = InferSelectModel<typeof plannedSessions>;
