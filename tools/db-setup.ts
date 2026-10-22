/**
 * Creates the local Postgres role and every database in services.json, plus the
 * test database. Idempotent. Needs a superuser connection:
 *   PG_ADMIN_URL (default postgresql://$USER@localhost:5432/postgres)
 */
import pg from 'pg';
import { DEFAULT_PG_ADMIN_URL, readRegistry, TEST_DATABASE } from './lib.ts';

const adminUrl = process.env['PG_ADMIN_URL'] ?? DEFAULT_PG_ADMIN_URL;
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const role = await client.query("select 1 from pg_roles where rolname = 'ga'");
  if (role.rowCount === 0) {
    await client.query("create role ga login password 'ga' createdb");
    console.log('created role ga');
  }
  const services = readRegistry().services;
  const databases = [...services.map((s) => s.database), TEST_DATABASE];
  for (const name of databases) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing unsafe database name ${name}`);
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await client.query(`create database "${name}" owner ga`);
      console.log(`created database ${name}`);
    } else {
      console.log(`database ${name} exists`);
    }
  }
} finally {
  await client.end();
}

// Extensions: in each service database that needs them, and in the shared test database.
const extensionsByDatabase = new Map<string, Set<string>>();
for (const service of readRegistry().services) {
  for (const extension of service.extensions ?? []) {
    for (const database of [service.database, TEST_DATABASE]) {
      const set = extensionsByDatabase.get(database) ?? new Set<string>();
      set.add(extension);
      extensionsByDatabase.set(database, set);
    }
  }
}
for (const [database, extensions] of extensionsByDatabase) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    for (const extension of extensions) {
      if (!/^[a-z_][a-z0-9_]*$/.test(extension))
        throw new Error(`refusing unsafe extension name ${extension}`);
      await db.query(`create extension if not exists ${extension} with schema public`);
      console.log(`extension ${extension} ready in ${database}`);
    }
  } finally {
    await db.end();
  }
}
