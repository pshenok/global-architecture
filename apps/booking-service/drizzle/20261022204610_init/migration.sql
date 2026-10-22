CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY,
	"house_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"guests" integer NOT NULL,
	"total_price_minor" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"cancelled_at" timestamp(3) with time zone,
	CONSTRAINT "bookings_dates_check" CHECK ("check_in" < "check_out"),
	CONSTRAINT "bookings_status_check" CHECK ("status" in ('CONFIRMED', 'CANCELLED')),
	CONSTRAINT "bookings_guests_check" CHECK ("guests" > 0)
);
--> statement-breakpoint
CREATE INDEX "bookings_house_id_idx" ON "bookings" ("house_id");--> statement-breakpoint
CREATE INDEX "bookings_guest_id_idx" ON "bookings" ("guest_id");