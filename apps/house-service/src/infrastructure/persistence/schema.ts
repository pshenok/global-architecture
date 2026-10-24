import { sql } from 'drizzle-orm';
import {
  bigint,
  bytea,
  char,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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

/**
 * Events committed with the change that caused them, until the kit's relay publishes
 * them (ADR-0005). Copied verbatim from the ga-database skill; EventsModule checks it.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    payload: bytea('payload').notNull(),
    requestId: text('request_id'),
    traceparent: text('traceparent'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    leaseToken: uuid('lease_token'),
    lastError: text('last_error'),
  },
  (table) => [
    index('outbox_available_at_idx').on(table.availableAt, table.id),
    check('outbox_payload_size_check', sql`octet_length(${table.payload}) <= 65536`),
  ],
);

/**
 * Events this service's handlers have applied, so a redelivery is skipped (ADR-0005).
 * Copied verbatim from the ga-database skill; EventsModule checks it.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    subscription: text('subscription').notNull(),
    eventId: uuid('event_id').notNull(),
    type: text('type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subscription, table.eventId] }),
    index('processed_events_processed_at_idx').on(table.processedAt),
  ],
);
