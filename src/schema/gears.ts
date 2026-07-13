import { type InferInsertModel, type InferSelectModel, relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { gearSurfaceEnum, gearTypeEnum, trainingBucketEnum, trainingTypeEnum } from "./enums";
import { intervalStructures } from "./interval_structure";
import { users } from "./users";

export const gears = pgTable(
  "gears",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    gearType: gearTypeEnum("gear_type").notNull().default("SHOES"),
    brand: text("brand"),
    model: text("model").notNull(),
    nickname: text("nickname"),
    surface: gearSurfaceEnum("surface").notNull().default("ROAD"),
    useTypes: trainingTypeEnum("use_types").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    retiredAt: timestamp("retired_at"),
    stravaGearId: text("strava_gear_id"),
    baselineDistanceMeters: doublePrecision("baseline_distance_meters").notNull().default(0),
    baselineDate: timestamp("baseline_date"),
    maintainedDistanceMeters: doublePrecision("maintained_distance_meters").notNull().default(0),
    activityCount: integer("activity_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("gears_user_idx").on(table.userId),
    index("gears_user_active_idx").on(table.userId, table.isActive),
    uniqueIndex("gears_user_strava_gear_id_unique")
      .on(table.userId, table.stravaGearId)
      .where(sql`strava_gear_id IS NOT NULL`),
  ],
);

export const gearDefaults = pgTable(
  "gear_defaults",
  {
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    gearType: gearTypeEnum("gear_type").notNull().default("SHOES"),
    bucket: trainingBucketEnum("bucket").notNull(),
    surface: gearSurfaceEnum("surface").notNull(),
    gearId: integer("gear_id")
      .references(() => gears.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.gearType, table.bucket, table.surface] }),
    index("gear_defaults_gear_idx").on(table.gearId),
  ],
);

export const gearSignatureDefaults = pgTable(
  "gear_signature_defaults",
  {
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    intervalStructureId: integer("interval_structure_id")
      .references(() => intervalStructures.id)
      .notNull(),
    gearId: integer("gear_id")
      .references(() => gears.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.intervalStructureId] }),
    index("gear_signature_defaults_gear_idx").on(table.gearId),
  ],
);

export const gearsRelations = relations(gears, ({ one, many }) => ({
  user: one(users, { fields: [gears.userId], references: [users.id] }),
  activities: many(activities),
  defaults: many(gearDefaults),
}));

export const gearDefaultsRelations = relations(gearDefaults, ({ one }) => ({
  user: one(users, { fields: [gearDefaults.userId], references: [users.id] }),
  gear: one(gears, { fields: [gearDefaults.gearId], references: [gears.id] }),
}));

export const gearSignatureDefaultsRelations = relations(gearSignatureDefaults, ({ one }) => ({
  user: one(users, { fields: [gearSignatureDefaults.userId], references: [users.id] }),
  gear: one(gears, { fields: [gearSignatureDefaults.gearId], references: [gears.id] }),
  intervalStructure: one(intervalStructures, {
    fields: [gearSignatureDefaults.intervalStructureId],
    references: [intervalStructures.id],
  }),
}));

export type InsertGear = InferInsertModel<typeof gears>;
export type SelectGear = InferSelectModel<typeof gears>;
export type InsertGearDefault = InferInsertModel<typeof gearDefaults>;
export type SelectGearDefault = InferSelectModel<typeof gearDefaults>;
export type InsertGearSignatureDefault = InferInsertModel<typeof gearSignatureDefaults>;
export type SelectGearSignatureDefault = InferSelectModel<typeof gearSignatureDefaults>;
