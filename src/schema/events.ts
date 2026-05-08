import { type InferInsertModel, relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { eventStatusEnum, eventTypeEnum } from "./enums";
import { users } from "./users";

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    eventType: eventTypeEnum("event_type").notNull(),
    bodyLocation: text("body_location"),
    description: text("description").notNull(),
    startTime: timestamp("start_time").notNull(),
    lastOccurrence: timestamp("last_occurrence").notNull(),
    status: eventStatusEnum("status").notNull().default("active"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("events_user_idx").on(table.userId),
    index("events_user_last_occ_idx").on(table.userId, table.lastOccurrence),
    index("events_user_type_idx").on(table.userId, table.eventType),
  ],
);

export const activityEvents = pgTable(
  "activity_events",
  {
    activityId: integer("activity_id")
      .references(() => activities.id, { onDelete: "cascade" })
      .notNull(),
    eventId: integer("event_id")
      .references(() => events.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activityId, table.eventId] }),
    index("activity_events_activity_idx").on(table.activityId),
    index("activity_events_event_idx").on(table.eventId),
  ],
);

export const eventsRelations = relations(events, ({ one, many }) => ({
  user: one(users, { fields: [events.userId], references: [users.id] }),
  activityEvents: many(activityEvents),
}));

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  activity: one(activities, {
    fields: [activityEvents.activityId],
    references: [activities.id],
  }),
  event: one(events, {
    fields: [activityEvents.eventId],
    references: [events.id],
  }),
}));

export type InsertEvent = InferInsertModel<typeof events>;
export type InsertActivityEvent = InferInsertModel<typeof activityEvents>;
