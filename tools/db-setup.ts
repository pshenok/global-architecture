/**
 * Creates the local Postgres role and every database in services.json, plus the
 * test database. Idempotent. Needs a superuser connection:
 *   PG_ADMIN_URL (default postgresql://$USER@localhost:5432/postgres)
 *
 *   pnpm db:setup --reset ga_booking [...] --yes [--adopt]
 *     drops and recreates the named databases first (dev data only). Refused in
 *     production and for a Postgres that is not local (loopback or a Unix socket). It
 *     drops only a database db:setup created: one with its comment marker, or, with
 *     --adopt, one an older db:setup made before the marker existed (no comment, owned by
 *     `ga`). A database created any other way is never dropped. The marker cannot tell a
 *     shared server behind a localhost tunnel from your own: never reset through one.
 */
import { isIPv4 } from 'node:net';
import pg from 'pg';
import { ensureEnvFiles } from './env-files.ts';
import { DEFAULT_PG_ADMIN_URL, readRegistry, TEST_DATABASE } from './lib.ts';

/** Written on every database db:setup creates; --reset drops only databases that carry it. */
const LOCAL_MARKER = 'global-architecture local stack (pnpm db:setup)';

for (const file of ensureEnvFiles()) console.log(`created ${file} from .env.example`);

const adminUrl = process.env.PG_ADMIN_URL ?? DEFAULT_PG_ADMIN_URL;
if (!URL.canParse(adminUrl)) {
  throw new Error(
    'PG_ADMIN_URL is not a URL (for a Unix socket: postgresql:///postgres?host=/path)',
  );
}
const args = process.argv.slice(2);
const toReset = args.includes('--reset') ? args.filter((arg) => !arg.startsWith('--')) : [];
const adopt = args.includes('--adopt');

/** The server PG_ADMIN_URL reaches, resolved by node-postgres itself (URL, ?host=, PGHOST). */
const serverHost = (url: string) => new pg.Client({ connectionString: url }).host;
/** A Unix socket, localhost, ::1 or an IPv4 loopback address (not a name like 127.example). */
const isLocal = (host: string) =>
  host.startsWith('/') ||
  host === 'localhost' ||
  host === '::1' ||
  (isIPv4(host) && host.startsWith('127.'));

if (toReset.length > 0) {
  const known = new Set([...readRegistry().services.map((s) => s.database), TEST_DATABASE]);
  if (process.env.NODE_ENV === 'production') throw new Error('--reset is refused in production');
  if (!args.includes('--yes')) throw new Error(`--reset drops ${toReset.join(', ')}: add --yes`);
  for (const name of toReset) {
    if (!known.has(name)) throw new Error(`--reset: ${name} is not a database of this repository`);
  }
  const host = serverHost(adminUrl);
  if (!isLocal(host)) {
    throw new Error(`--reset only drops databases on a local Postgres, not on ${host}`);
  }
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // Check every database before dropping any of them.
  const { rows: existing } = await client.query<{
    name: string;
    marker: string | null;
    owner: string;
  }>(
    "select datname as name, shobj_description(oid, 'pg_database') as marker, pg_get_userbyid(datdba) as owner from pg_database where datname = any($1)",
    [toReset],
  );
  for (const { name, marker, owner } of existing) {
    if (marker === LOCAL_MARKER) continue;
    // What db:setup made before it wrote the marker: owned by ga, no comment.
    const older = marker === null && owner === 'ga';
    if (older && adopt) continue;
    throw new Error(
      older
        ? `--reset: ${name} has no local-stack marker; if it is your own local database from an older pnpm db:setup, add --adopt`
        : `--reset: ${name} was not created by pnpm db:setup; drop it by hand if it really is disposable`,
    );
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
      const { rows } = await client.query<{ marker: string | null; owner: string }>(
        "select shobj_description(oid, 'pg_database') as marker, pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
        [name],
      );
      const [{ marker, owner } = { marker: null, owner: '' }] = rows;
      const note =
        marker === LOCAL_MARKER
          ? ''
          : marker === null && owner === 'ga'
            ? ' (made by an older db:setup: --reset needs --adopt once)'
            : ' (not made by db:setup: --reset refuses it)';
      console.log(`database ${name} exists${note}`);
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
