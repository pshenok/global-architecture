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
  const databases = [...readRegistry().services.map((s) => s.database), TEST_DATABASE];
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
