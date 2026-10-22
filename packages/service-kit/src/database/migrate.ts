import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  /** Folder produced by `drizzle-kit generate`. */
  readonly migrationsFolder: string;
  /** Advisory-lock key; use the service name. */
  readonly lockKey: string;
  /** Schema for the migrations bookkeeping table (tests use one schema per run). */
  readonly migrationsSchema?: string;
}

/**
 * Applies pending Drizzle migrations. Safe when N replicas start at once: a
 * session-level advisory lock serialises migrators (Drizzle's own migrator takes
 * no lock and concurrent runs crash). Run it as a release step, not in main.ts.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
    application_name: `${options.lockKey}:migrator`,
  });
  const lockClient = await pool.connect();
  try {
    await lockClient.query('select pg_advisory_lock(hashtext($1))', [
      `${options.lockKey}:migrations`,
    ]);
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: options.migrationsFolder,
      ...(options.migrationsSchema ? { migrationsSchema: options.migrationsSchema } : {}),
    });
  } finally {
    await lockClient
      .query('select pg_advisory_unlock(hashtext($1))', [`${options.lockKey}:migrations`])
      .catch(() => undefined);
    lockClient.release();
    await pool.end();
  }
}
