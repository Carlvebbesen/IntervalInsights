CREATE TYPE "public"."analysis_review_mode" AS ENUM('all', 'intervals_only', 'none');--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"wait_for_strava_update" boolean DEFAULT true NOT NULL,
	"analysis_review_mode" "analysis_review_mode" DEFAULT 'all' NOT NULL,
	"max_heart_rate" integer,
	"process_heart_rate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;