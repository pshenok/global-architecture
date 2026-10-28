CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	"payload" bytea NOT NULL,
	"request_id" text,
	"traceparent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"last_error" text,
	CONSTRAINT "outbox_payload_size_check" CHECK (octet_length("payload") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"subscription" text,
	"event_id" uuid,
	"type" text NOT NULL,
	"processed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_pkey" PRIMARY KEY("subscription","event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_available_at_idx" ON "outbox" ("available_at","id");--> statement-breakpoint
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events" ("processed_at");