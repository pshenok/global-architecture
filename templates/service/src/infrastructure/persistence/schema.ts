import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Database schema of this service: the single source of truth for migrations
 * (`pnpm db:generate` diffs it into SQL under ./drizzle). Only this service may
 * touch these tables; other services go through its gRPC API.
 */
export const sampleItems = pgTable(
  'sample_items',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [unique('sample_items_name_key').on(table.name)],
);

export type SampleItemRow = typeof sampleItems.$inferSelect;
