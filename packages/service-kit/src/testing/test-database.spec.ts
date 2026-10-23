import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, DEFAULT_TEST_DATABASE_URL } from './test-database.ts';

/** Real Postgres: a test schema never outlives its test, even when migrations fail. */
describe('createTestDatabase', () => {
  const baseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const folders: string[] = [];

  function migrationsFolder(sql: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'ga-migrations-'));
    folders.push(folder);
    const migration = join(folder, '20260101000000_init');
    mkdirSync(migration);
    writeFileSync(join(migration, 'migration.sql'), sql);
    writeFileSync(join(migration, 'snapshot.json'), '{}');
    return folder;
  }

  async function schemaExists(schema: string): Promise<boolean> {
    const found = await admin.query('select 1 from pg_namespace where nspname = $1', [schema]);
    return found.rowCount === 1;
  }

  afterAll(async () => {
    await admin.end();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  it('drops the schema on dispose', async () => {
    const db = await createTestDatabase({
      migrationsFolder: migrationsFolder('create table widgets (id int primary key);'),
    });
    expect(await schemaExists(db.schema)).toBe(true);
    await db.dispose();
    expect(await schemaExists(db.schema)).toBe(false);
  });

  it('drops the schema when migrations fail', async () => {
    const failure = await createTestDatabase({
      migrationsFolder: migrationsFolder('create table widgets (id int primary key;'),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const schema = /test schema (t_[0-9a-f]{12})/.exec(String(failure))?.[1];
    expect(schema).toBeDefined();
    expect(await schemaExists(schema ?? '')).toBe(false);
  });
});
