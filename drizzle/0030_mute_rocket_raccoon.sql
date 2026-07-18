CREATE TYPE "public"."plan_week_phase" AS ENUM('base', 'build', 'peak', 'taper', 'race');--> statement-breakpoint
CREATE TYPE "public"."planned_session_status" AS ENUM('planned', 'completed', 'skipped', 'moved');--> statement-breakpoint
CREATE TYPE "public"."race_event_status" AS ENUM('upcoming', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."race_priority" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."training_plan_status" AS ENUM('draft', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "planned_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"week_id" integer NOT NULL,
	"date" date NOT NULL,
	"session_type" "training_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"structure" jsonb,
	"status" "planned_session_status" DEFAULT 'planned' NOT NULL,
	"completed_activity_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"distance_meters" integer NOT NULL,
	"target_time_seconds" integer,
	"priority" "race_priority" DEFAULT 'B' NOT NULL,
	"status" "race_event_status" DEFAULT 'upcoming' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plan_weeks" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"week_index" integer NOT NULL,
	"start_date" date NOT NULL,
	"phase" "plan_week_phase",
	"target_distance_meters" integer,
	"target_load" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "training_plan_status" DEFAULT 'draft' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"race_event_id" integer,
	"goal_text" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_week_id_training_plan_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."training_plan_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_completed_activity_id_activities_id_fk" FOREIGN KEY ("completed_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_events" ADD CONSTRAINT "race_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_weeks" ADD CONSTRAINT "training_plan_weeks_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_race_event_id_race_events_id_fk" FOREIGN KEY ("race_event_id") REFERENCES "public"."race_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_sessions_plan_idx" ON "planned_sessions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "planned_sessions_week_idx" ON "planned_sessions" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "planned_sessions_plan_date_idx" ON "planned_sessions" USING btree ("plan_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_sessions_completed_activity_idx" ON "planned_sessions" USING btree ("completed_activity_id");--> statement-breakpoint
CREATE INDEX "race_events_user_idx" ON "race_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "race_events_user_date_idx" ON "race_events" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "training_plan_weeks_plan_week_idx" ON "training_plan_weeks" USING btree ("plan_id","week_index");--> statement-breakpoint
CREATE INDEX "training_plan_weeks_plan_idx" ON "training_plan_weeks" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "training_plans_user_idx" ON "training_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "training_plans_user_status_idx" ON "training_plans" USING btree ("user_id","status");