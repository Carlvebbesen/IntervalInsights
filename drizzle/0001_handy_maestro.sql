CREATE TYPE "public"."analysis_status_enum" AS ENUM('pending', 'ongoing_init', 'initial', 'ongoing_completed', 'completed', 'error');--> statement-breakpoint
CREATE TYPE "public"."interval_type" AS ENUM('SPRINTS', 'HILL_SPRINTS', 'ANAEROBIC_CAPACITY', 'VO2_MAX', 'THRESHOLD', 'CRITICAL_VELOCITY', 'FARTLEK', 'RECOVERY_INTERVALS');--> statement-breakpoint
CREATE TYPE "public"."target_type_enum" AS ENUM('time', 'distance', 'custom');--> statement-breakpoint
CREATE TYPE "public"."user_role_enum" AS ENUM('guest', 'premium', 'admin');--> statement-breakpoint
CREATE TYPE "public"."workout_part" AS ENUM('INTERVALS', 'REST', 'ACTIVE_REST', 'WARMUP', 'COOL_DOWN', 'JOGGING');--> statement-breakpoint
ALTER TABLE "feedback_training_data" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "feedback_training_data" CASCADE;--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "training_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "interval_structures" ALTER COLUMN "training_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."training_type";--> statement-breakpoint
CREATE TYPE "public"."training_type" AS ENUM('LONG_RUN', 'EASY_RUN', 'NORMAL_RUN', 'RECOVERY', 'SHORT_INTERVALS', 'HILL_SPRINTS', 'LONG_INTERVALS', 'SPRINTS', 'FARTLEK', 'PROGRESSIVE_LONG_RUN', 'RACE', 'TEMPO', 'OTHER');--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "training_type" SET DATA TYPE "public"."training_type" USING "training_type"::"public"."training_type";--> statement-breakpoint
ALTER TABLE "interval_structures" ALTER COLUMN "training_type" SET DATA TYPE "public"."training_type" USING "training_type"::"public"."training_type";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "analysis_status" SET DEFAULT 'pending'::"public"."analysis_status_enum";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "analysis_status" SET DATA TYPE "public"."analysis_status_enum" USING "analysis_status"::"public"."analysis_status_enum";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "strava_activity_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "feeling" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "set_group_index" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "type" SET DATA TYPE "public"."workout_part" USING "type"::"public"."workout_part";--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "target_value" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "actual_distance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "actual_duration" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ALTER COLUMN "actual_pace" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role_enum" DEFAULT 'guest';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "process_heart_rate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_policy_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_policy_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_of_service_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_of_service_version" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "draft_analysis_result" json;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "gear_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "has_heart_rate" boolean;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "gear_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "created_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "average_tmp" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "indoor" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "target_type" "target_type_enum" NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "time_series_index_end" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "median_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "interval_structures" ADD COLUMN "interval_type" interval_type;--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "ai_classified_type";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "classification_confidence";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "classification_reasoning";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "user_confirmed_type";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "feedback_notes";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "feedback_at";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "max_speed";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "rpe";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "processed_at";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "avg_power";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "compliance_score";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "pace_deviation";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "effort_quality";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "detection_confidence";--> statement-breakpoint
ALTER TABLE "interval_structures" DROP COLUMN "detected_pattern";--> statement-breakpoint
ALTER TABLE "interval_structures" DROP COLUMN "confidence";--> statement-breakpoint
ALTER TABLE "interval_structures" DROP COLUMN "suggested_name";--> statement-breakpoint
ALTER TABLE "interval_structures" DROP COLUMN "occurrence_count";