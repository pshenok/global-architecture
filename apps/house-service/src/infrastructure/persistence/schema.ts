import { sql } from 'drizzle-orm';
import { bigint, char, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Database schema of the house service (source of truth for `pnpm db:generate`). */
export const houses = pgTable(
  'houses',
  {
    id: uuid('id').primaryKey(),
    /** A user id owned by user-service: no foreign key across service boundaries. */
    ownerId: uuid('owner_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    addressLine1: text('address_line1').notNull(),
    city: text('city').notNull(),
    countryCode: char('country_code', { length: 2 }).notNull(),
    nightlyPriceMinor: bigint('nightly_price_minor', { mode: 'number' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    maxGuests: integer('max_guests').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    // (filter, id) indexes serve the filtered keyset lists: WHERE owner_id = $1 AND id < $2 ORDER BY id DESC
    index('houses_owner_id_id_idx').on(table.ownerId, table.id),
    index('houses_city_lower_id_idx').on(sql`lower(${table.city})`, table.id),
  ],
);

export type HouseRow = typeof houses.$inferSelect;
