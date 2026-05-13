CREATE TYPE "public"."event_status" AS ENUM('active', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('INJURY', 'ILLNESS', 'MEDICAL_VISIT', 'PHYSIO_VISIT', 'OTHER');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"activity_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_activity_id_event_id_pk" PRIMARY KEY("activity_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" "event_type" NOT NULL,
	"body_location" text,
	"description" text NOT NULL,
	"start_time" timestamp NOT NULL,
	"last_occurrence" timestamp NOT NULL,
	"status" "event_status" DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_activity_idx" ON "activity_events" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "activity_events_event_idx" ON "activity_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_user_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_user_last_occ_idx" ON "events" USING btree ("user_id","last_occurrence");--> statement-breakpoint
CREATE INDEX "events_user_type_idx" ON "events" USING btree ("user_id","event_type");