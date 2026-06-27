CREATE TYPE "public"."gear_surface" AS ENUM('ROAD', 'TRAIL');--> statement-breakpoint
CREATE TYPE "public"."gear_type" AS ENUM('SHOES');--> statement-breakpoint
CREATE TYPE "public"."training_bucket" AS ENUM('EASY', 'LONG', 'INTERVALS');--> statement-breakpoint
CREATE TABLE "gear_defaults" (
	"user_id" uuid NOT NULL,
	"bucket" "training_bucket" NOT NULL,
	"surface" "gear_surface" NOT NULL,
	"gear_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gear_defaults_user_id_bucket_surface_pk" PRIMARY KEY("user_id","bucket","surface")
);
--> statement-breakpoint
CREATE TABLE "gears" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"gear_type" "gear_type" DEFAULT 'SHOES' NOT NULL,
	"brand" text,
	"model" text NOT NULL,
	"nickname" text,
	"surface" "gear_surface" DEFAULT 'ROAD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp,
	"strava_gear_id" text,
	"baseline_distance_meters" double precision DEFAULT 0 NOT NULL,
	"baseline_date" timestamp,
	"maintained_distance_meters" double precision DEFAULT 0 NOT NULL,
	"activity_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "local_gear_id" integer;--> statement-breakpoint
ALTER TABLE "gear_defaults" ADD CONSTRAINT "gear_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gear_defaults" ADD CONSTRAINT "gear_defaults_gear_id_gears_id_fk" FOREIGN KEY ("gear_id") REFERENCES "public"."gears"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gears" ADD CONSTRAINT "gears_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gear_defaults_gear_idx" ON "gear_defaults" USING btree ("gear_id");--> statement-breakpoint
CREATE INDEX "gears_user_idx" ON "gears" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gears_user_active_idx" ON "gears" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "gears_user_strava_gear_id_unique" ON "gears" USING btree ("user_id","strava_gear_id") WHERE strava_gear_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_local_gear_id_gears_id_fk" FOREIGN KEY ("local_gear_id") REFERENCES "public"."gears"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_gear_idx" ON "activities" USING btree ("local_gear_id");