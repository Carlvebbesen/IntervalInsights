ALTER TABLE "activities" ADD COLUMN "intervals_icu_enriched_at" timestamp;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "elapsed_time" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "max_heart_rate" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "average_power" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "weighted_average_power" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "calories" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "training_load" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "icu_training_load" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "icu_intensity" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "relative_intensity" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "decoupling" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "polarization_index" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "icu_ftp" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "icu_ctl" double precision;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "icu_atl" double precision;