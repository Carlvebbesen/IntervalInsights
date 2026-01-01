CREATE TYPE "public"."training_type" AS ENUM('LONG_RUN', 'EASY_RUN', 'SHORT_INTERVALS', 'HILL_SPRINTS', 'LONG_INTERVALS', 'SPRINTS', 'FARTLEK', 'PROGRESSIVE_LONG_RUN', 'RACE', 'TEMPO', 'RECOVERY', 'OTHER');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" text NOT NULL,
	"strava_id" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "users_strava_id_unique" UNIQUE("strava_id")
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"training_type" "training_type",
	"interval_structure_id" integer,
	"ai_classified_type" "training_type",
	"classification_confidence" double precision,
	"classification_reasoning" text,
	"user_confirmed_type" "training_type",
	"feedback_notes" text,
	"feedback_at" timestamp,
	"analyzed_at" timestamp,
	"analysis_status" text DEFAULT 'pending',
	"analysis_version" text DEFAULT 'v1.0',
	"strava_activity_id" text NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"description" text,
	"sport_type" text NOT NULL,
	"distance" double precision NOT NULL,
	"moving_time" integer NOT NULL,
	"elapsed_time" integer NOT NULL,
	"total_elevation_gain" double precision,
	"average_speed" double precision,
	"max_speed" double precision,
	"average_heart_rate" double precision,
	"max_heart_rate" double precision,
	"start_date_local" timestamp NOT NULL,
	"rpe" integer,
	"feeling" text,
	"notes" text,
	"processed_at" timestamp DEFAULT now(),
	CONSTRAINT "activities_strava_activity_id_unique" UNIQUE("strava_activity_id")
);
--> statement-breakpoint
CREATE TABLE "interval_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"segment_index" integer NOT NULL,
	"set_group_index" integer,
	"type" text NOT NULL,
	"label" text,
	"target_value" double precision,
	"actual_distance" double precision,
	"actual_duration" integer,
	"actual_pace" double precision,
	"avg_heart_rate" integer,
	"max_heart_rate" integer,
	"avg_power" integer,
	"compliance_score" double precision,
	"target_pace" double precision,
	"pace_deviation" double precision,
	"effort_quality" text,
	"detection_confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "interval_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"signature" text,
	"training_type" "training_type" NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"detected_pattern" text,
	"confidence" double precision,
	"suggested_name" text,
	"occurrence_count" integer DEFAULT 1,
	CONSTRAINT "interval_structures_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "feedback_training_data" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer,
	"user_id" uuid,
	"ai_prediction" "training_type" NOT NULL,
	"ai_confidence" double precision,
	"user_correction" "training_type" NOT NULL,
	"user_reasoning" text,
	"activity_metrics" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_interval_structure_id_interval_structures_id_fk" FOREIGN KEY ("interval_structure_id") REFERENCES "public"."interval_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD CONSTRAINT "interval_segments_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_training_data" ADD CONSTRAINT "feedback_training_data_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_training_data" ADD CONSTRAINT "feedback_training_data_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_idx" ON "activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "date_idx" ON "activities" USING btree ("start_date_local");--> statement-breakpoint
CREATE INDEX "type_idx" ON "activities" USING btree ("training_type");--> statement-breakpoint
CREATE INDEX "interval_structure_idx" ON "activities" USING btree ("interval_structure_id");