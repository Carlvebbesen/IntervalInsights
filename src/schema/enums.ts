
import {  pgEnum, } from 'drizzle-orm/pg-core';
export const trainingTypeEnum = pgEnum('training_type', [
  'LONG_RUN',
  'EASY_RUN',
  "NORMAL_RUN",
  "RECOVERY",
  'SHORT_INTERVALS',
  'HILL_SPRINTS',
  'LONG_INTERVALS',
  'SPRINTS',
  'FARTLEK',
  'PROGRESSIVE_LONG_RUN',
  'RACE',
  'TEMPO',
  'OTHER'
]);

export const analysisStatusEnum = pgEnum("analysis_status_enum",[ "pending","ongoing_init","initial","ongoing_completed","completed", "error"]);

export const intervalTypeEnum = pgEnum("interval_type", [
  "SPRINTS",          
  "HILL_SPRINTS",     
  "ANAEROBIC_CAPACITY",
  "VO2_MAX",          
  "THRESHOLD",        
  "CRITICAL_VELOCITY",
  "FARTLEK",          
  "RECOVERY_INTERVALS"
]);
export const userRoleEnum = pgEnum("user_role_enum", [
  "guest",
  "premium",
  "admin",
]);
export const targetTypeEnum = pgEnum("target_type_enum", [
  "time",
  "distance",
  "custom",
]);

export type TargetTypeEnum = (typeof targetTypeEnum.enumValues)[number];
export type TrainingType = (typeof trainingTypeEnum.enumValues)[number];
export type IntervalType = (typeof intervalTypeEnum.enumValues)[number];

export const workoutPartEnum = pgEnum('workout_part', [
  "INTERVALS" , "REST", "ACTIVE_REST", "WARMUP" , "COOL_DOWN","JOGGING"
]);


export type WorkoutPartType = (typeof workoutPartEnum.enumValues)[number];