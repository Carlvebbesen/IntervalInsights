import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
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
import type { ExpandedIntervalSet } from "../types/ExpandedIntervalSet";
import type { IIntervalsInterval } from "../types/intervals/IIntervalsActivity";
import { analysisStatusEnum, type TrainingType, trainingTypeEnum } from "./enums";
import { activityEvents } from "./events";
import { intervalSegments } from "./interval_segments";
import { intervalStructures } from "./interval_structure";
import { users } from "./users";

export type IntervalsIcuPrediction = {
  trainingType?: TrainingType;
  subType?: string | null;
  intervals?: IIntervalsInterval[];
};

export type DraftAnalysisResult = WorkoutAnalysisOutput & {
  lapsMatchStructure?: boolean;
  intervalsIcuPrediction?: IntervalsIcuPrediction | null;
  acceptedSets?: ExpandedIntervalSet[];
  segmentsFromLaps?: boolean;
};

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
    analysisAttemptCount: integer("analysis_attempt_count").notNull().default(0),
    draftAnalysisResult: json("draft_analysis_result").$type<DraftAnalysisResult>(),
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
    intervalsIcuEnrichedAt: timestamp("intervals_icu_enriched_at"),
    elapsedTime: integer("elapsed_time"),
    maxHeartRate: integer("max_heart_rate"),
    averagePower: doublePrecision("average_power"),
    weightedAveragePower: doublePrecision("weighted_average_power"),
    calories: doublePrecision("calories"),
    deviceName: text("device_name"),
    trainingLoad: doublePrecision("training_load"),
    icuTrainingLoad: doublePrecision("icu_training_load"),
    icuIntensity: doublePrecision("icu_intensity"),
    relativeIntensity: doublePrecision("relative_intensity"),
    decoupling: doublePrecision("decoupling"),
    polarizationIndex: doublePrecision("polarization_index"),
    icuFtp: integer("icu_ftp"),
    icuCtl: doublePrecision("icu_ctl"),
    icuAtl: doublePrecision("icu_atl"),
    // Heart-rate distribution stats computed from the HR stream. avg/max are
    // already stored above (averageHeartRate/maxHeartRate); these add the
    // histogram-derived metrics. `work*` variants restrict to work intervals
    // (null when the activity has no stored work segments). `hrStatsComputedAt`
    // marks that computation was attempted, so we don't refetch streams for
    // activities that legitimately have no HR data.
    medianHeartRate: integer("median_heart_rate"),
    modeHeartRate: integer("mode_heart_rate"),
    workAvgHeartRate: integer("work_avg_heart_rate"),
    workMaxHeartRate: integer("work_max_heart_rate"),
    workMedianHeartRate: integer("work_median_heart_rate"),
    workModeHeartRate: integer("work_mode_heart_rate"),
    hrStatsComputedAt: timestamp("hr_stats_computed_at"),
  },
  (table) => {
    return [
      index("user_idx").on(table.userId),
      index("user_status_idx").on(table.userId, table.analysisStatus),
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
export type SelectActivity = InferSelectModel<typeof activities>;
