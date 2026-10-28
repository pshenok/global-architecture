CREATE TABLE "processed_events" (
	"subscription" text,
	"event_id" uuid,
	"type" text NOT NULL,
	"processed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_pkey" PRIMARY KEY("subscription","event_id")
);
--> statement-breakpoint
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events" ("processed_at");