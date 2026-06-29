CREATE TYPE "public"."script_run_status_enum" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "script_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "script_run_status_enum" DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer,
	"error" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE INDEX "script_runs_name_status_idx" ON "script_runs" USING btree ("name","status");