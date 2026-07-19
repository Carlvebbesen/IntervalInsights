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
export const sexEnum = pgEnum("sex", ["male", "female"]);
export type Sex = (typeof sexEnum.enumValues)[number];
export const analysisReviewModeEnum = pgEnum("analysis_review_mode", [
  "all",
  "intervals_only",
  "none",
]);
export type AnalysisReviewMode = (typeof analysisReviewModeEnum.enumValues)[number];
export const paceProgressionEnum = pgEnum("pace_progression", ["off", "mild", "aggressive"]);
export type PaceProgression = (typeof paceProgressionEnum.enumValues)[number];
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

export const IN_FLIGHT_STATUSES: readonly AnalysisStatus[] = [
  "ongoing_init",
  "ongoing_completed",
  "initial",
];

export const ACTIVE_RUN_STATUSES: readonly AnalysisStatus[] = ["ongoing_init", "ongoing_completed"];

export const SKIP_START_STATUSES: ReadonlySet<AnalysisStatus> = new Set<AnalysisStatus>([
  ...IN_FLIGHT_STATUSES,
  "completed",
]);

export const SKIP_RESTART_STATUSES: ReadonlySet<AnalysisStatus> = new Set<AnalysisStatus>([
  ...IN_FLIGHT_STATUSES,
  "skipped_inactive",
  "completed",
]);

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

export const noteSourceEnum = pgEnum("note_source", ["ai", "user"]);

export type NoteSource = (typeof noteSourceEnum.enumValues)[number];

export const noteTrendEnum = pgEnum("note_trend", ["improving", "worsening", "unchanged"]);

export type NoteTrend = (typeof noteTrendEnum.enumValues)[number];

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

export type ChatRole = (typeof chatRoleEnum.enumValues)[number];

export const chatMessageStatusEnum = pgEnum("chat_message_status", ["interrupted", "error"]);

export type ChatMessageStatus = (typeof chatMessageStatusEnum.enumValues)[number];

export const attributeValueTypeEnum = pgEnum("attribute_value_type", [
  "string",
  "number",
  "boolean",
  "datetime",
  "string_list",
  "number_list",
]);

export type AttributeValueType = (typeof attributeValueTypeEnum.enumValues)[number];

export const RUNNING_SPORT_TYPES = ["Run", "VirtualRun", "TrailRun"] as const;

export type RunningSportType = (typeof RUNNING_SPORT_TYPES)[number];

export function isPowerSport(sportType: string): boolean {
  return !(RUNNING_SPORT_TYPES as readonly string[]).includes(sportType);
}

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

export const gearTypeEnum = pgEnum("gear_type", ["SHOES", "BICYCLE", "SKIS"]);
export const gearSurfaceEnum = pgEnum("gear_surface", [
  "ROAD",
  "TRAIL",
  "TREADMILL",
  "GRAVEL",
  "MTB",
  "CLASSIC",
  "SKATE",
  "ROLLERSKI",
]);
export const trainingBucketEnum = pgEnum("training_bucket", ["EASY", "LONG", "INTERVALS", "RACE"]);

export type GearType = (typeof gearTypeEnum.enumValues)[number];
export type GearSurface = (typeof gearSurfaceEnum.enumValues)[number];
export type TrainingBucket = (typeof trainingBucketEnum.enumValues)[number];

export const SURFACES_BY_GEAR_TYPE = {
  SHOES: ["ROAD", "TRAIL", "TREADMILL"],
  BICYCLE: ["ROAD", "GRAVEL", "MTB"],
  SKIS: ["CLASSIC", "SKATE", "ROLLERSKI"],
} as const satisfies Record<GearType, readonly GearSurface[]>;

export function isSurfaceForGearType(gearType: GearType, surface: GearSurface): boolean {
  return (SURFACES_BY_GEAR_TYPE[gearType] as readonly GearSurface[]).includes(surface);
}

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

export type GearContext = { gearType: GearType; surface: GearSurface | null };

export function gearContextForActivity(sportType: string, indoor: boolean): GearContext | null {
  switch (sportType) {
    case "TrailRun":
      return { gearType: "SHOES", surface: "TRAIL" };
    case "Run":
    case "VirtualRun":
      return { gearType: "SHOES", surface: indoor ? "TREADMILL" : "ROAD" };
    case "Ride":
    case "VirtualRide":
    case "EBikeRide":
      return { gearType: "BICYCLE", surface: "ROAD" };
    case "GravelRide":
      return { gearType: "BICYCLE", surface: "GRAVEL" };
    case "MountainBikeRide":
      return { gearType: "BICYCLE", surface: "MTB" };
    case "NordicSki":
    case "BackcountrySki":
      return { gearType: "SKIS", surface: null };
    case "RollerSki":
      return { gearType: "SKIS", surface: "ROLLERSKI" };
    case "Hike":
    case "Elliptical":
      return { gearType: "SHOES", surface: null };
    default:
      return null;
  }
}

export const trainingPlanStatusEnum = pgEnum("training_plan_status", [
  "draft",
  "active",
  "completed",
  "archived",
]);
export type TrainingPlanStatus = (typeof trainingPlanStatusEnum.enumValues)[number];

export const plannedSessionStatusEnum = pgEnum("planned_session_status", [
  "planned",
  "completed",
  "skipped",
  "moved",
]);
export type PlannedSessionStatus = (typeof plannedSessionStatusEnum.enumValues)[number];

export const racePriorityEnum = pgEnum("race_priority", ["A", "B", "C"]);
export type RacePriority = (typeof racePriorityEnum.enumValues)[number];

export const raceEventStatusEnum = pgEnum("race_event_status", [
  "upcoming",
  "completed",
  "cancelled",
]);
export type RaceEventStatus = (typeof raceEventStatusEnum.enumValues)[number];

export const planWeekPhaseEnum = pgEnum("plan_week_phase", [
  "base",
  "build",
  "peak",
  "taper",
  "race",
]);
export type PlanWeekPhase = (typeof planWeekPhaseEnum.enumValues)[number];

export const STRAVA_GEAR_SPORT_TYPES = [
  "Run",
  "TrailRun",
  "VirtualRun",
  "Ride",
  "VirtualRide",
  "EBikeRide",
  "GravelRide",
  "MountainBikeRide",
] as const;
