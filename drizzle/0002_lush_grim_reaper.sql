ALTER TABLE "activities" ALTER COLUMN "training_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "interval_structures" ALTER COLUMN "training_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."training_type";--> statement-breakpoint
CREATE TYPE "public"."training_type" AS ENUM('LONG', 'EASY', 'RECOVERY', 'SHORT_INTERVALS', 'HILL_SPRINTS', 'LONG_INTERVALS', 'SPRINTS', 'FARTLEK', 'PROGRESSIVE_LONG', 'RACE', 'TEMPO', 'OTHER');--> statement-breakpoint
-- Remap legacy training_type values before re-casting to the new enum
UPDATE "activities" SET "training_type" = CASE "training_type"
  WHEN 'LONG_RUN' THEN 'LONG'
  WHEN 'EASY_RUN' THEN 'EASY'
  WHEN 'NORMAL_RUN' THEN 'EASY'
  WHEN 'PROGRESSIVE_LONG_RUN' THEN 'PROGRESSIVE_LONG'
  ELSE "training_type"
END
WHERE "training_type" IN ('LONG_RUN','EASY_RUN','NORMAL_RUN','PROGRESSIVE_LONG_RUN');--> statement-breakpoint
UPDATE "interval_structures" SET "training_type" = CASE "training_type"
  WHEN 'LONG_RUN' THEN 'LONG'
  WHEN 'EASY_RUN' THEN 'EASY'
  WHEN 'NORMAL_RUN' THEN 'EASY'
  WHEN 'PROGRESSIVE_LONG_RUN' THEN 'PROGRESSIVE_LONG'
  ELSE "training_type"
END
WHERE "training_type" IN ('LONG_RUN','EASY_RUN','NORMAL_RUN','PROGRESSIVE_LONG_RUN');--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "training_type" SET DATA TYPE "public"."training_type" USING "training_type"::"public"."training_type";--> statement-breakpoint
ALTER TABLE "interval_structures" ALTER COLUMN "training_type" SET DATA TYPE "public"."training_type" USING "training_type"::"public"."training_type";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "device_name";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "elapsed_time";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "average_speed";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "max_heart_rate";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "gear_name";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "average_tmp";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "actual_pace";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "max_heart_rate";--> statement-breakpoint
ALTER TABLE "interval_segments" DROP COLUMN "median_heart_rate";