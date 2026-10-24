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
import type { Database } from '../database/tokens.ts';

/*
 * The kit's view of the two event tables. Services own them: they copy the definitions
 * from the ga-database skill into their schema.ts, so their migrations create them.
 * assertEventTables checks at boot that the copy matches what the kit uses.
 */

/** Producer side: events committed with the change that caused them, until published. */
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

/** Consumer side: events whose handler committed, so a redelivery is skipped. */
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

const COPY_THEM =
  'copy the event tables from the ga-database skill into schema.ts and run db:generate';

/** Fails boot when a table the enabled side needs is missing or differs from the kit's. */
export async function assertEventTables(
  db: Database,
  sides: { readonly publish: boolean; readonly consume: boolean },
): Promise<void> {
  const check = async (table: string, probe: () => Promise<unknown>) => {
    try {
      await probe();
    } catch (error) {
      throw new Error(`EventsModule: table ${table} is missing or differs (${COPY_THEM})`, {
        cause: error,
      });
    }
  };
  if (sides.publish) {
    await check('outbox', () => db.select().from(outbox).limit(0));
  }
  if (sides.consume) {
    await check('processed_events', () => db.select().from(processedEvents).limit(0));
    const unique = await db.execute<{ ok: number }>(sql`
      select 1 as ok from pg_index i
      where i.indrelid = to_regclass('processed_events') and i.indisunique
        and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = i.indrelid and a.attnum = any(i.indkey))
            = array['event_id', 'subscription']`);
    if (unique.rows.length === 0) {
      throw new Error(
        `EventsModule: processed_events needs a unique key on (subscription, event_id) (${COPY_THEM})`,
      );
    }
  }
}
