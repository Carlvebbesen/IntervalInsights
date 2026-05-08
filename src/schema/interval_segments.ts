import { type InferInsertModel, relations } from "drizzle-orm";
import { doublePrecision, integer, pgTable, serial } from "drizzle-orm/pg-core";
import type { SplitMetrics } from "../types/strava/IDetailedActivity";
import { activities } from "./activities";
import { targetTypeEnum, workoutPartEnum } from "./enums";

export type InsertIntervalSegment = InferInsertModel<typeof intervalSegments>;

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
});

export const intervalSegmentsRelations = relations(intervalSegments, ({ one }) => ({
  activity: one(activities, {
    fields: [intervalSegments.activityId],
    references: [activities.id],
  }),
}));

export function getDbInsertIntervalSegmentsFromStravaMetrics(
  activityId: number,
  splits: SplitMetrics[],
): InsertIntervalSegment[] {
  let cumulativeTime = 0;
  return splits.map((split) => {
    cumulativeTime += split.elapsed_time;
    return {
      activityId: activityId,
      segmentIndex: split.split,
      setGroupIndex: 0,
      type: "JOGGING",
      targetValue: 1000,
      targetType: "distance",
      targetPace: null,
      timeSeriesEndTime: cumulativeTime,
      actualDistance: split.distance,
      actualDuration: split.moving_time,
      avgHeartRate: split.average_heartrate ? Math.round(split.average_heartrate) : null,
    };
  });
}
