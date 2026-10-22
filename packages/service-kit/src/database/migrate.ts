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
  /**
   * Max wait for a table/row lock inside a migration (default 5000 ms). A migration that
   * queues behind live traffic fails fast instead of blocking every query behind it.
   * It does not limit waiting for the migration advisory lock itself.
   */
  readonly lockTimeoutMs?: number;
}

/**
 * Applies pending Drizzle migrations. Safe when N replicas start at once: a
 * session-level advisory lock serialises migrators (Drizzle's own migrator takes
 * no lock and concurrent runs crash). Run it as a release step, not in main.ts.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const key = `${options.lockKey}:migrations`;
  // Dedicated session for the advisory lock: no lock_timeout, replicas wait their turn.
  const lockClient = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: `${options.lockKey}:migrator-lock`,
  });
  await lockClient.connect();
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 1,
    application_name: `${options.lockKey}:migrator`,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
  });
  try {
    await lockClient.query('select pg_advisory_lock(hashtext($1))', [key]);
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: options.migrationsFolder,
      ...(options.migrationsSchema ? { migrationsSchema: options.migrationsSchema } : {}),
    });
  } finally {
    await lockClient.query('select pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
    await lockClient.end();
    await pool.end();
  }
}
