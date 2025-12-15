import { doublePrecision, index, integer, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { intervalStructures } from "./interval_structure";
import { trainingTypeEnum } from "./enums";
import { intervalSegments } from "./interval_segments";
import { relations } from "drizzle-orm";

export const activities = pgTable('activities', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  
  // -- New Relations --
  // 1. The high-level category (Enum)
  trainingType: trainingTypeEnum('training_type'), 
  
  // 2. The specific structure definition (Relation)
  intervalStructureId: integer('interval_structure_id')
    .references(() => intervalStructures.id),

  // -- Strava Data --
  stravaActivityId: text('strava_activity_id').unique().notNull(),
  externalId: text('external_id'),
  
  // -- Display Data --
  name: text('name').notNull(),
  description: text('description'),
  sportType: text('sport_type').notNull(), // "Run", "TrailRun", "Ride"
  
  // -- Key Metrics --
  distance: doublePrecision('distance').notNull(), // meters
  movingTime: integer('moving_time').notNull(), // seconds
  elapsedTime: integer('elapsed_time').notNull(), 
  totalElevationGain: doublePrecision('total_elevation_gain'),
  averageSpeed: doublePrecision('average_speed'), // m/s
  maxSpeed: doublePrecision('max_speed'),
  averageHeartRate: doublePrecision('average_heart_rate'),
  maxHeartRate: doublePrecision('max_heart_rate'),
  
  // -- Visuals & Metadata --
  startDateLocal: timestamp('start_date_local').notNull(),
  
  // -- User Enrichment --
  rpe: integer('rpe'),
  feeling: text('feeling'),
  notes: text('notes'),
  
  processedAt: timestamp('processed_at').defaultNow(),
}, (table) => {
  return {
    userIdx: index('user_idx').on(table.userId),
    dateIdx: index('date_idx').on(table.startDateLocal),
    typeIdx: index('type_idx').on(table.trainingType), // Index for quick filtering by type
    intervalStructureIdx: index('interval_structure_idx').on(table.intervalStructureId),
  };
});

export const activitiesRelations = relations(activities, ({ one, many }) => ({
  user: one(users, {
    fields: [activities.userId],
    references: [users.id],
  }),
  intervalStructure: one(intervalStructures, {
    fields: [activities.intervalStructureId],
    references: [intervalStructures.id],
  }),
  intervals: many(intervalSegments),
}));
