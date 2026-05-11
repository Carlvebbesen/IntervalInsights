ALTER TABLE "users" ADD COLUMN "intervals_athlete_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "intervals_icu_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "intervals_analyzed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_intervals_athlete_id_unique" UNIQUE("intervals_athlete_id");