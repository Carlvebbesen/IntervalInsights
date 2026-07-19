CREATE TYPE "public"."note_source" AS ENUM('ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."note_trend" AS ENUM('improving', 'worsening', 'unchanged');--> statement-breakpoint
CREATE TABLE "event_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text NOT NULL,
	"source" "note_source" NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"trend" "note_trend",
	"severity" integer,
	"is_anchor" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_notes" ADD CONSTRAINT "event_notes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_notes" ADD CONSTRAINT "event_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_notes_event_occurred_idx" ON "event_notes" USING btree ("event_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_notes_anchor_idx" ON "event_notes" USING btree ("event_id") WHERE "event_notes"."is_anchor";