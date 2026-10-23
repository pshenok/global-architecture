import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Database schema of this service: the single source of truth for migrations
 * (`pnpm db:generate` diffs it into SQL under ./drizzle). Only this service may
 * touch these tables; other services go through its gRPC API.
 */
export const sampleItems = pgTable(
  'sample_items',
  {
    id: uuid('id').primaryKey(),
    /** user-service id of the creator: no foreign key across service boundaries. */
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    // Names are unique per owner: a global key would tell users which names others use.
    unique('sample_items_owner_id_name_key').on(table.ownerId, table.name),
    // (owner_id, id) serves the owner-scoped keyset list: WHERE owner_id = $1 AND id < $2
    index('sample_items_owner_id_id_idx').on(table.ownerId, table.id),
  ],
);

export type SampleItemRow = typeof sampleItems.$inferSelect;
