import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_DATABASE_URL, withSearchPath } from '../testing/test-database.ts';
import { runMigrations } from './migrate.ts';

/** Real Postgres: concurrent migrators apply a migration exactly once. */
describe('runMigrations', () => {
  const baseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const schema = `t_migrate_${process.pid}`;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  let folder: string;

  beforeAll(async () => {
    await admin.query(`drop schema if exists "${schema}" cascade; create schema "${schema}"`);
    folder = mkdtempSync(join(tmpdir(), 'ga-migrations-'));
    const migration = join(folder, '20260101000000_init');
    mkdirSync(migration);
    writeFileSync(join(migration, 'migration.sql'), 'create table widgets (id int primary key);');
    writeFileSync(join(migration, 'snapshot.json'), '{}');
  });

  afterAll(async () => {
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  });

  it('serializes concurrent runs with the advisory lock', async () => {
    const url = withSearchPath(baseUrl, schema);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        runMigrations({
          databaseUrl: url,
          migrationsFolder: folder,
          lockKey: schema,
          migrationsSchema: schema,
        }),
      ),
    );
    const applied = await admin.query(
      `select count(*)::int as n from "${schema}".__drizzle_migrations`,
    );
    expect(applied.rows[0].n).toBe(1);
    const tables = await admin.query(
      `select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = 'widgets'`,
      [schema],
    );
    expect(tables.rows[0].n).toBe(1);
  });
});
