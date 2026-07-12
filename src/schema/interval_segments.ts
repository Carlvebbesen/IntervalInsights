import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { doublePrecision, integer, pgTable, serial } from "drizzle-orm/pg-core";
import { activities } from "./activities";
import { targetTypeEnum, workoutPartEnum } from "./enums";

export type InsertIntervalSegment = InferInsertModel<typeof intervalSegments>;
export type SelectIntervalSegment = InferSelectModel<typeof intervalSegments>;

export const intervalSegments = pgTable("interval_segments", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id")
    .references(() => activities.id, { onDelete: "cascade" })
    .notNull(),
  segmentIndex: integer("segment_index").notNull(),
  setGroupIndex: integer("set_group_index").notNull(),
  type: workoutPartEnum("type").notNull(),
  targetValue: doublePrecision("target_value").notNull(),
  targetType: targetTypeEnum("target_type").notNull(),
  targetPace: doublePrecision("target_pace"),
  timeSeriesEndTime: doublePrecision("time_series_index_end").notNull(),
  actualDistance: doublePrecision("actual_distance").notNull(),
  actualDuration: integer("actual_duration").notNull(),
  avgHeartRate: integer("avg_heart_rate"),
  recoveryTargetType: targetTypeEnum("recovery_target_type"),
  recoveryTargetValue: doublePrecision("recovery_target_value"),
  recoveryEndTime: doublePrecision("recovery_end_time"),
  recoveryDistance: doublePrecision("recovery_distance"),
  recoveryDuration: integer("recovery_duration"),
  recoveryAvgHeartRate: integer("recovery_avg_heart_rate"),
});

export const intervalSegmentsRelations = relations(intervalSegments, ({ one }) => ({
  activity: one(activities, {
    fields: [intervalSegments.activityId],
    references: [activities.id],
  }),
}));
