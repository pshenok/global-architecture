-- DEV-DATA-ONLY (ADR-0004). host_id snapshots the house owner, which this service
-- cannot backfill (bookings of deleted houses have no owner left). It shipped before
-- any real data existed. With real data this change would be expand (nullable column)
-- -> backfill from house-service -> contract (SET NOT NULL); see the ga-database skill.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bookings) THEN
    RAISE EXCEPTION 'bookings has rows from before ADR-0004 (no host_id): reset the dev database with pnpm db:setup --reset ga_booking --yes';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "host_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "bookings_host_id_id_idx" ON "bookings" ("host_id","id");