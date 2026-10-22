DROP INDEX "bookings_house_id_idx";--> statement-breakpoint
DROP INDEX "bookings_guest_id_idx";--> statement-breakpoint
CREATE INDEX "bookings_house_id_id_idx" ON "bookings" ("house_id","id");--> statement-breakpoint
CREATE INDEX "bookings_guest_id_id_idx" ON "bookings" ("guest_id","id");