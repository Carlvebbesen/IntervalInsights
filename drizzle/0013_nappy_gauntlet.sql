ALTER TABLE "activities" DROP CONSTRAINT "activities_strava_activity_id_unique";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "strava_activity_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "strava_activity_id_unique" ON "activities" USING btree ("strava_activity_id") WHERE strava_activity_id IS NOT NULL;