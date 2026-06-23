ALTER TABLE "activities" ADD COLUMN "intervals_strava_id" bigint;--> statement-breakpoint
CREATE INDEX "intervals_strava_id_idx" ON "activities" USING btree ("intervals_strava_id");