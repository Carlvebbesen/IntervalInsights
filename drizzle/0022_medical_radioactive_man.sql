CREATE TABLE "gear_signature_defaults" (
	"user_id" uuid NOT NULL,
	"interval_structure_id" integer NOT NULL,
	"gear_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gear_signature_defaults_user_id_interval_structure_id_pk" PRIMARY KEY("user_id","interval_structure_id")
);
--> statement-breakpoint
ALTER TABLE "gear_signature_defaults" ADD CONSTRAINT "gear_signature_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gear_signature_defaults" ADD CONSTRAINT "gear_signature_defaults_interval_structure_id_interval_structures_id_fk" FOREIGN KEY ("interval_structure_id") REFERENCES "public"."interval_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gear_signature_defaults" ADD CONSTRAINT "gear_signature_defaults_gear_id_gears_id_fk" FOREIGN KEY ("gear_id") REFERENCES "public"."gears"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gear_signature_defaults_gear_idx" ON "gear_signature_defaults" USING btree ("gear_id");