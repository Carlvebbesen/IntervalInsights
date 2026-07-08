CREATE TYPE "public"."oauth_provider" AS ENUM('strava', 'intervals');--> statement-breakpoint
CREATE TABLE "oauth_provider_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp,
	"athlete_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_provider_tokens_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "oauth_provider_tokens" ADD CONSTRAINT "oauth_provider_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;