import { doublePrecision, integer, pgTable, serial, text, } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { relations } from "drizzle-orm";


export const intervalSegments = pgTable('interval_segments', {
  id: serial('id').primaryKey(),
  activityId: integer('activity_id').references(() => activities.id, { onDelete: 'cascade' }).notNull(),
  
  segmentIndex: integer('segment_index').notNull(), // Order: 1, 2, 3
  setGroupIndex: integer('set_group_index'), // Grouping ID for series
  
  type: text('type').notNull(), // 'WORK', 'RECOVERY', 'WARMUP', 'COOL_DOWN'
  label: text('label'), // "1km", "Rest"
  
  // Target vs Actual
  targetValue: doublePrecision('target_value'), // Planned distance/time
  actualDistance: doublePrecision('actual_distance'), // meters
  actualDuration: integer('actual_duration'), // seconds
  actualPace: doublePrecision('actual_pace'), // seconds/meter
  avgHeartRate: integer('avg_heart_rate'),
  maxHeartRate: integer('max_heart_rate'),
  avgPower: integer('avg_power'),
  
  complianceScore: doublePrecision('compliance_score'),
});


export const intervalSegmentsRelations = relations(intervalSegments, ({ one }) => ({
  activity: one(activities, {
    fields: [intervalSegments.activityId],
    references: [activities.id],
  }),
}));