import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { attributeValueTypeEnum, eventStatusEnum, eventTypeEnum } from "./enums";
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

export const eventAttributes = pgTable(
  "event_attributes",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .references(() => events.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    key: text("key").notNull(),
    valueType: attributeValueTypeEnum("value_type").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("event_attributes_event_idx").on(table.eventId),
    index("event_attributes_user_key_idx").on(table.userId, table.key),
    uniqueIndex("event_attributes_event_key_idx").on(table.eventId, table.key),
  ],
);

export const eventsRelations = relations(events, ({ one, many }) => ({
  user: one(users, { fields: [events.userId], references: [users.id] }),
  activityEvents: many(activityEvents),
  attributes: many(eventAttributes),
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

export const eventAttributesRelations = relations(eventAttributes, ({ one }) => ({
  event: one(events, {
    fields: [eventAttributes.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [eventAttributes.userId],
    references: [users.id],
  }),
}));

export type InsertEvent = InferInsertModel<typeof events>;
export type InsertActivityEvent = InferInsertModel<typeof activityEvents>;
export type InsertEventAttribute = InferInsertModel<typeof eventAttributes>;
export type SelectEvent = InferSelectModel<typeof events>;
export type SelectActivityEvent = InferSelectModel<typeof activityEvents>;
export type SelectEventAttribute = InferSelectModel<typeof eventAttributes>;
