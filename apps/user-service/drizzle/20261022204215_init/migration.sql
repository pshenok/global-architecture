CREATE TABLE "users" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL CONSTRAINT "users_email_key" UNIQUE,
	"full_name" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
