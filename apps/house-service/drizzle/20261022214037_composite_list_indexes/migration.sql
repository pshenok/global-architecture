DROP INDEX "houses_owner_id_idx";--> statement-breakpoint
DROP INDEX "houses_city_lower_idx";--> statement-breakpoint
CREATE INDEX "houses_owner_id_id_idx" ON "houses" ("owner_id","id");--> statement-breakpoint
CREATE INDEX "houses_city_lower_id_idx" ON "houses" (lower("city"),"id");