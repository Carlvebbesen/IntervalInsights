import {
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  boolean,
  bigint,
  json,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { intervalStructures } from "./interval_structure";
import { analysisStatusEnum, trainingTypeEnum } from "./enums";
import { intervalSegments } from "./interval_segments";
import { InferInsertModel, relations } from "drizzle-orm";
import { DetailedActivity } from "../types/strava/IDetailedActivity";
import { WorkoutAnalysisOutput } from "../agent/initial_analysis_agent";

export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    trainingType: trainingTypeEnum("training_type"),
    intervalStructureId: integer("interval_structure_id").references(
      () => intervalStructures.id
    ),
    analyzedAt: timestamp("analyzed_at"),
    analysisStatus: analysisStatusEnum("analysis_status").default("pending"),
    draftAnalysisResult: json("draft_analysis_result").$type<WorkoutAnalysisOutput>(),
    analysisVersion: text("analysis_version").default("v1.0"),
    stravaActivityId: bigint("strava_activity_id",{ mode: "number" }).unique().notNull(),
    gearId: text("gear_id"),
    hasHeartrate: boolean("has_heart_rate"),
    title: text("title").notNull(),
    description: text("description"),
    sportType: text("sport_type").notNull(),
    deviceName: text("device_name"),
    distance: doublePrecision("distance").notNull(),
    movingTime: integer("moving_time").notNull(),
    elapsedTime: integer("elapsed_time").notNull(),
    totalElevationGain: doublePrecision("total_elevation_gain"),
    averageSpeed: doublePrecision("average_speed"),
    averageHeartRate: doublePrecision("average_heart_rate"),
    maxHeartRate: doublePrecision("max_heart_rate"),
    startDateLocal: timestamp("start_date_local").notNull(),
    feeling: integer("feeling"),
    notes: text("notes"),
    gearName: text("gear_name"),
    createdAt: timestamp("created_at").defaultNow(),
    averageTmp: integer("average_tmp"),
    indoor: boolean("indoor").notNull(),
  },
  (table) => {
    return[
      index("user_idx").on(table.userId),
      index("date_idx").on(table.startDateLocal),
      index("type_idx").on(table.trainingType),
      index("interval_structure_idx").on(
        table.intervalStructureId
      ),
    ];
  }
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
}));

export type InsertActivity = InferInsertModel<typeof activities>;


export function getDbInsertActivity(data: DetailedActivity, userId: string): InsertActivity{
return {
    userId,
    stravaActivityId: data.id,
    title: data.name,
    description: data.description,
    sportType: data.sport_type || data.type,
    distance: data.distance,
    movingTime: data.moving_time,
    elapsedTime: data.elapsed_time,
    totalElevationGain: data.total_elevation_gain,
    averageSpeed: data.average_speed,
    averageHeartRate: data.average_heartrate,
    maxHeartRate: data.max_heartrate,
    startDateLocal: new Date(data.start_date_local),
    hasHeartrate: data.has_heartrate,
    gearId: data.gear_id,
    deviceName: data.device_name,
    gearName: data?.gear?.name,
    indoor: data.trainer,
    averageTmp: data.average_temp,
  };
}