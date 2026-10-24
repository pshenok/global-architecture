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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Database schema of the user service (source of truth for `pnpm db:generate`). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Null when the identity provider shares no email (NULLs never collide in the unique key). */
    email: text('email'),
    fullName: text('full_name').notNull(),
    /** Platform roles; the check constraint lists every role this version knows. */
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    unique('users_email_key').on(table.email),
    check('users_roles_check', sql`${table.roles} <@ ARRAY['admin']::text[]`),
  ],
);

/** Identity-provider logins of a user: (issuer, subject) is unique across the platform. */
export const userIdentities = pgTable(
  'user_identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ name: 'user_identities_pkey', columns: [table.issuer, table.subject] }),
    index('user_identities_user_id_idx').on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;

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
