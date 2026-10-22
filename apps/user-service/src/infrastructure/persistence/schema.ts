import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Database schema of the user service (source of truth for `pnpm db:generate`). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [unique('users_email_key').on(table.email)],
);

export type UserRow = typeof users.$inferSelect;
