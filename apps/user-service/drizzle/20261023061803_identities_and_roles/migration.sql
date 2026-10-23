CREATE TABLE "user_identities" (
	"issuer" text,
	"subject" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" ("user_id");--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_roles_check" CHECK ("roles" <@ ARRAY['admin']::text[]);