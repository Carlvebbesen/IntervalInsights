CREATE TYPE "public"."attribute_value_type" AS ENUM('string', 'number', 'boolean', 'datetime', 'string_list', 'number_list');--> statement-breakpoint
CREATE TABLE "event_attributes" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_type" "attribute_value_type" NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_attributes" ADD CONSTRAINT "event_attributes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attributes" ADD CONSTRAINT "event_attributes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attributes_event_idx" ON "event_attributes" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_attributes_user_key_idx" ON "event_attributes" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attributes_event_key_idx" ON "event_attributes" USING btree ("event_id","key");