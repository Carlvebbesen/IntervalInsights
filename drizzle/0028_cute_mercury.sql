ALTER TABLE "gear_defaults" ADD COLUMN "gear_type" "gear_type" DEFAULT 'SHOES' NOT NULL;--> statement-breakpoint
ALTER TABLE "gear_defaults" DROP CONSTRAINT "gear_defaults_user_id_bucket_surface_pk";--> statement-breakpoint
ALTER TABLE "gear_defaults" ADD CONSTRAINT "gear_defaults_user_id_gear_type_bucket_surface_pk" PRIMARY KEY("user_id","gear_type","bucket","surface");
