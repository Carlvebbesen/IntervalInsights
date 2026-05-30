ALTER TABLE "activities" ADD COLUMN "median_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "mode_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "work_avg_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "work_max_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "work_median_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "work_mode_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "hr_stats_computed_at" timestamp;