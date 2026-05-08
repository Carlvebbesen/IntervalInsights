import { type InferInsertModel, relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { WorkoutAnalysisOutput } from "../agent/initial_analysis_agent";
import type { DetailedActivity } from "../types/strava/IDetailedActivity";
import { analysisStatusEnum, trainingTypeEnum } from "./enums";
import { activityEvents } from "./events";
import { intervalSegments } from "./interval_segments";
import { intervalStructures } from "./interval_structure";
import { users } from "./users";

export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    trainingType: trainingTypeEnum("training_type"),
    intervalStructureId: integer("interval_structure_id").references(() => intervalStructures.id),
    analyzedAt: timestamp("analyzed_at"),
    analysisStatus: analysisStatusEnum("analysis_status").default("pending"),
    draftAnalysisResult: json("draft_analysis_result").$type<WorkoutAnalysisOutput>(),
    analysisVersion: text("analysis_version").default("v1.0"),
    stravaActivityId: bigint("strava_activity_id", { mode: "number" }).unique().notNull(),
    gearId: text("gear_id"),
    hasHeartrate: boolean("has_heart_rate"),
    title: text("title").notNull(),
    description: text("description"),
    sportType: text("sport_type").notNull(),
    distance: doublePrecision("distance").notNull(),
    movingTime: integer("moving_time").notNull(),
    totalElevationGain: doublePrecision("total_elevation_gain"),
    averageHeartRate: doublePrecision("average_heart_rate"),
    startDateLocal: timestamp("start_date_local").notNull(),
    feeling: integer("feeling"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
    indoor: boolean("indoor").notNull(),
    intervalsIcuId: text("intervals_icu_id"),
    intervalsAnalyzed: boolean("intervals_analyzed").default(false),
  },
  (table) => {
    return [
      index("user_idx").on(table.userId),
      index("date_idx").on(table.startDateLocal),
      index("type_idx").on(table.trainingType),
      index("interval_structure_idx").on(table.intervalStructureId),
    ];
  },
);

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
  activityEvents: many(activityEvents),
}));

export type InsertActivity = InferInsertModel<typeof activities>;

export function getDbInsertActivity(
  data: DetailedActivity,
  userId: string,
  processHeartRate: boolean,
): InsertActivity {
  return {
    userId,
    stravaActivityId: data.id,
    title: data.name,
    description: data.description,
    sportType: data.sport_type || data.type,
    distance: data.distance,
    movingTime: data.moving_time,
    totalElevationGain: data.total_elevation_gain,
    averageHeartRate: processHeartRate ? data.average_heartrate : null,
    startDateLocal: new Date(data.start_date_local),
    hasHeartrate: processHeartRate ? data.has_heartrate : false,
    gearId: data.gear_id,
    indoor: data.trainer,
  };
}
