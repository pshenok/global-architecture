CREATE TABLE "houses" (
	"id" uuid PRIMARY KEY,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"address_line1" text NOT NULL,
	"city" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"nightly_price_minor" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"max_guests" integer NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "houses_owner_id_idx" ON "houses" ("owner_id");--> statement-breakpoint
CREATE INDEX "houses_city_lower_idx" ON "houses" (lower("city"));