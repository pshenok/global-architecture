/**
 * Creates the local Postgres role and every database in services.json, plus the
 * test database. Idempotent. Needs a superuser connection:
 *   PG_ADMIN_URL (default postgresql://$USER@localhost:5432/postgres)
 *
 *   pnpm db:setup --reset ga_booking [...] --yes
 *     drops and recreates the named databases first (dev data only). It drops only a
 *     database that db:setup itself created (it carries a comment marker), never one
 *     created any other way, e.g. by infrastructure behind a localhost tunnel or proxy;
 *     refused when NODE_ENV is production.
 */
import pg from 'pg';
import { ensureEnvFiles } from './env-files.ts';
import { DEFAULT_PG_ADMIN_URL, readRegistry, TEST_DATABASE } from './lib.ts';

/** Written on every database db:setup creates; --reset drops only databases that carry it. */
const LOCAL_MARKER = 'global-architecture local stack (pnpm db:setup)';

for (const file of ensureEnvFiles()) console.log(`created ${file} from .env.example`);

const adminUrl = process.env.PG_ADMIN_URL ?? DEFAULT_PG_ADMIN_URL;
const args = process.argv.slice(2);
const toReset = args.includes('--reset') ? args.filter((arg) => !arg.startsWith('--')) : [];
if (toReset.length > 0) {
  const known = new Set([...readRegistry().services.map((s) => s.database), TEST_DATABASE]);
  if (process.env.NODE_ENV === 'production') throw new Error('--reset is refused in production');
  if (!args.includes('--yes')) throw new Error(`--reset drops ${toReset.join(', ')}: add --yes`);
  for (const name of toReset) {
    if (!known.has(name)) throw new Error(`--reset: ${name} is not a database of this repository`);
  }
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // Check every database before dropping any of them.
  const { rows: existing } = await client.query<{ name: string; marker: string | null }>(
    "select datname as name, shobj_description(oid, 'pg_database') as marker from pg_database where datname = any($1)",
    [toReset],
  );
  for (const { name, marker } of existing) {
    if (marker !== LOCAL_MARKER) {
      throw new Error(
        `--reset: ${name} was not created by pnpm db:setup (no local-stack marker); drop it by hand if it really is disposable`,
      );
    }
  }
  for (const { name } of existing) {
    await client.query(`drop database "${name}" with (force)`);
    console.log(`dropped database ${name}`);
  }
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
      await client.query(`comment on database "${name}" is '${LOCAL_MARKER}'`);
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
