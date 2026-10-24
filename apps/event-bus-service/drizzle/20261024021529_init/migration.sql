CREATE TABLE "deliveries" (
	"subscriber" text,
	"event_id" uuid,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"last_error" text,
	CONSTRAINT "deliveries_pkey" PRIMARY KEY("subscriber","event_id"),
	CONSTRAINT "deliveries_status_check" CHECK ("status" in ('PENDING', 'DEAD'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"producer" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	"published_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"traceparent" text,
	"payload" bytea NOT NULL,
	CONSTRAINT "events_payload_size_check" CHECK (octet_length("payload") <= 65536)
);
--> statement-breakpoint
CREATE INDEX "deliveries_pending_idx" ON "deliveries" ("subscriber","available_at","event_id") WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "deliveries_dead_idx" ON "deliveries" ("subscriber","event_id") WHERE "status" = 'DEAD';--> statement-breakpoint
CREATE INDEX "deliveries_event_id_idx" ON "deliveries" ("event_id");--> statement-breakpoint
CREATE INDEX "events_published_at_idx" ON "events" ("published_at");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT;