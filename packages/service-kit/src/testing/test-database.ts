import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../database/migrate.ts';

export interface TestDatabase {
  /** Connection URL pinned to the test schema (pass it as DATABASE_URL). */
  readonly url: string;
  readonly schema: string;
  readonly pool: pg.Pool;
  /** Empties the given tables between tests. */
  truncate(...tables: string[]): Promise<void>;
  /** Drops the schema. Call in afterAll. */
  dispose(): Promise<void>;
}

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://ga:ga@localhost:5432/ga_test';

/** Adds `-c search_path=<schema>,public` to a connection URL (public keeps shared extensions visible). */
export function withSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

/**
 * A real Postgres schema per test file, with the service's migrations applied.
 * Isolated, parallel-safe and fast, with no Docker needed. Uses
 * TEST_DATABASE_URL (default ga_test on localhost; `pnpm db:setup` creates it).
 */
export async function createTestDatabase(options: {
  readonly migrationsFolder: string;
  readonly baseUrl?: string;
}): Promise<TestDatabase> {
  const baseUrl = options.baseUrl ?? process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`create schema "${schema}"`);
  } catch (error) {
    await admin.end();
    throw new Error(
      `cannot create a test schema in ${new URL(baseUrl).pathname.slice(1)} (run \`pnpm db:setup\`): ${String(error)}`,
    );
  }
  const url = withSearchPath(baseUrl, schema);
  await runMigrations({
    databaseUrl: url,
    migrationsFolder: options.migrationsFolder,
    lockKey: schema,
    migrationsSchema: schema,
  });
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    url,
    schema,
    pool,
    async truncate(...tables) {
      if (tables.length === 0) return;
      await pool.query(
        `truncate table ${tables.map((t) => `"${schema}"."${t}"`).join(', ')} cascade`,
      );
    },
    async dispose() {
      await pool.end();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    },
  };
}
