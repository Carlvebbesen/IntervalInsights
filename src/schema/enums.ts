import { pgEnum } from "drizzle-orm/pg-core";
export const trainingTypeEnum = pgEnum("training_type", [
  "LONG",
  "EASY",
  "RECOVERY",
  "SHORT_INTERVALS",
  "HILL_SPRINTS",
  "LONG_INTERVALS",
  "SPRINTS",
  "FARTLEK",
  "PROGRESSIVE_LONG",
  "RACE",
  "TEMPO",
  "OTHER",
]);

export const analysisStatusEnum = pgEnum("analysis_status_enum", [
  "pending",
  "ongoing_init",
  "initial",
  "ongoing_completed",
  "completed",
  "error",
  "skipped_inactive",
]);

export const intervalTypeEnum = pgEnum("interval_type", [
  "SPRINTS",
  "HILL_SPRINTS",
  "ANAEROBIC_CAPACITY",
  "VO2_MAX",
  "THRESHOLD",
  "CRITICAL_VELOCITY",
  "FARTLEK",
  "RECOVERY_INTERVALS",
]);
export const userRoleEnum = pgEnum("user_role_enum", ["guest", "premium", "admin"]);
export const oauthProviderEnum = pgEnum("oauth_provider", ["strava", "intervals"]);
export type OAuthProvider = (typeof oauthProviderEnum.enumValues)[number];
export const targetTypeEnum = pgEnum("target_type_enum", ["time", "distance", "custom"]);
export const scriptRunStatusEnum = pgEnum("script_run_status_enum", [
  "running",
  "completed",
  "failed",
]);

export type TargetTypeEnum = (typeof targetTypeEnum.enumValues)[number];
export type ScriptRunStatus = (typeof scriptRunStatusEnum.enumValues)[number];
export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type TrainingType = (typeof trainingTypeEnum.enumValues)[number];
export type AnalysisStatus = (typeof analysisStatusEnum.enumValues)[number];

/** Statuses where the LangGraph thread is mid-flight or finished — never restart. */
export const IN_FLIGHT_STATUSES: readonly AnalysisStatus[] = [
  "ongoing_init",
  "ongoing_completed",
  "initial",
];

/**
 * Statuses where the graph is actively EXECUTING (vs `initial`, which is parked
 * at an interrupt). Even a forced re-analyze must not reset a running thread.
 */
export const ACTIVE_RUN_STATUSES: readonly AnalysisStatus[] = ["ongoing_init", "ongoing_completed"];

/** Statuses where `startAnalysis` must early-return (in-flight + already-done). */
export const SKIP_START_STATUSES: ReadonlySet<AnalysisStatus> = new Set<AnalysisStatus>([
  ...IN_FLIGHT_STATUSES,
  "completed",
]);

/** Statuses where a Strava update webhook must NOT trigger a restart. */
export const SKIP_RESTART_STATUSES: ReadonlySet<AnalysisStatus> = new Set<AnalysisStatus>([
  ...IN_FLIGHT_STATUSES,
  "skipped_inactive",
  "completed",
]);

/** Training types that count as interval / quality sessions */
export const INTERVAL_TRAINING_TYPES = [
  "TEMPO",
  "PROGRESSIVE_LONG",
  "LONG_INTERVALS",
  "SHORT_INTERVALS",
  "SPRINTS",
  "HILL_SPRINTS",
  "FARTLEK",
] as const satisfies readonly TrainingType[];

export type IntervalTrainingType = (typeof INTERVAL_TRAINING_TYPES)[number];
export type IntervalType = (typeof intervalTypeEnum.enumValues)[number];

export const workoutPartEnum = pgEnum("workout_part", [
  "INTERVALS",
  "REST",
  "ACTIVE_REST",
  "WARMUP",
  "COOL_DOWN",
  "JOGGING",
]);

export type WorkoutPartType = (typeof workoutPartEnum.enumValues)[number];

export const eventTypeEnum = pgEnum("event_type", [
  "INJURY",
  "ILLNESS",
  "MEDICAL_VISIT",
  "PHYSIO_VISIT",
  "OTHER",
]);

export type EventType = (typeof eventTypeEnum.enumValues)[number];

export const eventStatusEnum = pgEnum("event_status", ["active", "resolved"]);

export type EventStatus = (typeof eventStatusEnum.enumValues)[number];

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

export type ChatRole = (typeof chatRoleEnum.enumValues)[number];

export const attributeValueTypeEnum = pgEnum("attribute_value_type", [
  "string",
  "number",
  "boolean",
  "datetime",
  "string_list",
  "number_list",
]);

export type AttributeValueType = (typeof attributeValueTypeEnum.enumValues)[number];

// ─── Sport Type Constants ─────────────────────────────────────────────────────

/** All Strava sport types that count as "running" */
export const RUNNING_SPORT_TYPES = ["Run", "VirtualRun", "TrailRun"] as const;

export type RunningSportType = (typeof RUNNING_SPORT_TYPES)[number];

/** Sport types included in the "other activities" effort graph */
export const OTHER_SPORT_TYPES = [
  "NordicSki",
  "BackcountrySki",
  "Elliptical",
  "Swim",
  "Ride",
  "VirtualRide",
  "EBikeRide",
  "Walk",
  "Hike",
] as const;

export type OtherSportType = (typeof OTHER_SPORT_TYPES)[number];

// ─── Gear ─────────────────────────────────────────────────────────────────────

export const gearTypeEnum = pgEnum("gear_type", ["SHOES"]);
export const gearSurfaceEnum = pgEnum("gear_surface", ["ROAD", "TRAIL"]);
export const trainingBucketEnum = pgEnum("training_bucket", ["EASY", "LONG", "INTERVALS", "RACE"]);

export type GearType = (typeof gearTypeEnum.enumValues)[number];
export type GearSurface = (typeof gearSurfaceEnum.enumValues)[number];
export type TrainingBucket = (typeof trainingBucketEnum.enumValues)[number];

/** Coarse bucket a shoe default/suggestion is keyed on (together with surface). */
export function trainingBucketFor(
  trainingType: TrainingType | null | undefined,
): TrainingBucket | null {
  switch (trainingType) {
    case "EASY":
    case "RECOVERY":
      return "EASY";
    case "LONG":
    case "PROGRESSIVE_LONG":
      return "LONG";
    case "SHORT_INTERVALS":
    case "LONG_INTERVALS":
    case "HILL_SPRINTS":
    case "SPRINTS":
    case "FARTLEK":
    case "TEMPO":
      return "INTERVALS";
    case "RACE":
      return "RACE";
    default:
      return null;
  }
}

/** Road vs trail surface inferred from a Strava sport type. */
export function surfaceForSportType(sportType: string): GearSurface {
  return sportType === "TrailRun" ? "TRAIL" : "ROAD";
}
