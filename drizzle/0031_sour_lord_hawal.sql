CREATE TYPE "public"."sex" AS ENUM('male', 'female');--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "training_load_source" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "threshold_pace_mps" double precision;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "lthr" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "resting_hr" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "ftp" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "sex" "sex";