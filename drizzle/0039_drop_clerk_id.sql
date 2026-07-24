DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "email" IS NULL) THEN
    RAISE EXCEPTION 'Phase 6 gate 2 unmet: % users row(s) still have a NULL email. Run the Clerk email backfill from main before deploying this migration.',
      (SELECT count(*) FROM "users" WHERE "email" IS NULL);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_clerk_id_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "clerk_id";