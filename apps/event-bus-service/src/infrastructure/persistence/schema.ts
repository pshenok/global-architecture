import { sql } from 'drizzle-orm';
import {
  bytea,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Database schema of the event bus (source of truth for `pnpm db:generate`): the store of
 * the Postgres backend, read and written only by PostgresEventBroker and
 * PostgresEventBrokerAdmin. Another backend brings its own store (ADR-0005).
 */
export const events = pgTable(
  'events',
  {
    /** The producer's event id: Publish is idempotent by it. */
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    /** The verified caller of Publish, never a request field. */
    producer: text('producer').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    requestId: text('request_id'),
    traceparent: text('traceparent'),
    payload: bytea('payload').notNull(),
  },
  (table) => [
    index('events_published_at_idx').on(table.publishedAt),
    check('events_payload_size_check', sql`octet_length(${table.payload}) <= 65536`),
  ],
);

/** One queue row per (subscriber, event); acked rows are deleted, dead ones stay. */
export const deliveries = pgTable(
  'deliveries',
  {
    subscriber: text('subscriber').notNull(),
    /** Restrict: retention can never drop an event that still has a delivery. */
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    /** Copied from the event, so Pull filters without a join. */
    type: text('type').notNull(),
    status: text('status', { enum: ['PENDING', 'DEAD'] }).notNull(),
    /** Counted when leased, so a consumer that crashes mid-delivery still uses attempts up. */
    attempts: integer('attempts').notNull().default(0),
    /** Leasable when <= now(); a lease or a backoff moves it forward. */
    availableAt: timestamp('available_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    leaseToken: uuid('lease_token'),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ columns: [table.subscriber, table.eventId] }),
    index('deliveries_pending_idx')
      .on(table.subscriber, table.availableAt, table.eventId)
      .where(sql`${table.status} = 'PENDING'`),
    index('deliveries_dead_idx')
      .on(table.subscriber, table.eventId)
      .where(sql`${table.status} = 'DEAD'`),
    index('deliveries_event_id_idx').on(table.eventId),
    check('deliveries_status_check', sql`${table.status} in ('PENDING', 'DEAD')`),
  ],
);

/**
 * What writers store in deliveries.available_at to make a row leasable at once. The
 * column keeps milliseconds and rounds now() to them, maybe up, so a pull within that
 * millisecond would not see the row yet: truncate instead.
 */
export const leasableNow = sql`date_trunc('milliseconds', now())`;
