ALTER TYPE "public"."analysis_status_enum" ADD VALUE 'skipped_inactive';--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "analysis_attempt_count" integer DEFAULT 0 NOT NULL;