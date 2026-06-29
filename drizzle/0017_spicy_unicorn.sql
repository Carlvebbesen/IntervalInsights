ALTER TABLE "interval_segments" ADD COLUMN "recovery_target_type" "target_type_enum";--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "recovery_target_value" double precision;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "recovery_end_time" double precision;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "recovery_distance" double precision;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "recovery_duration" integer;--> statement-breakpoint
ALTER TABLE "interval_segments" ADD COLUMN "recovery_avg_heart_rate" integer;