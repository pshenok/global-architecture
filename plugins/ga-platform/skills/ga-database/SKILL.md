---

name: ga-database
description: Postgres and Drizzle ORM (1.0 RC, core query builder) in global-architecture services - schema.ts as the source of truth, drizzle-kit migrations (generate, custom SQL, never push), advisory-locked migration runs, constraints that enforce invariants, translateDbError, DbContext/UnitOfWork transactions, keyset pagination and scoped list queries, money/date/timestamp/role column types, database-per-service rules and zero-downtime schema changes (expand -> backfill -> contract for required columns). Use it for any table, column, index, constraint, migration, query, repository or transaction work, and whenever a race condition or data-integrity rule is involved.
---

# Database

Each service owns one Postgres database (`ga_<noun>`); nothing else reads or writes it.
Drizzle's TypeScript schema is the single source of truth; SQL migrations are generated
from it, reviewed in the PR, and applied as a release step.

## Files

```
src/infrastructure/persistence/schema.ts                  tables, constraints, indexes
src/infrastructure/persistence/drizzle-<noun>.repository.ts  adapter of the domain port
src/migrate.ts                                             release entrypoint (advisory lock)
drizzle/<timestamp>_<name>/migration.sql + snapshot.json   generated, committed
drizzle.config.ts
```

## Column conventions

| Data                                        | Column                                                                                                 | Notes                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| id                                          | `uuid('id').primaryKey()`                                                                              | value from `IdGenerator` (UUIDv7); no DB default          |
| reference to another service's entity       | `uuid('owner_id').notNull()` + index                                                                   | no foreign key across services                            |
| text                                        | `text(...)`                                                                                            | lengths are enforced in the domain                        |
| money                                       | `bigint('x_minor', { mode: 'number' })` + `char('currency_code', { length: 3 })`                       | integer minor units                                       |
| timestamp                                   | `timestamp('created_at', { withTimezone: true, precision: 3 })`                                        | ms precision round-trips with JS Date                     |
| calendar date                               | `date('check_in', { mode: 'string' })`                                                                 | 'YYYY-MM-DD' strings, no time zone bugs                   |
| enum-like status                            | `text('status', { enum: [...] })` + `check(...)`                                                       | adding a value is a migration (see zero-downtime)         |
| set of enum-like values (roles)             | `text('roles').array().notNull()` + `check('users_roles_check', sql\`... <@ ARRAY['admin']::text[]\`)` | every element must be known; adding a role is a migration |
| small bounded integer (rating 1..5, guests) | `smallint`/`integer` + `check('x_check', sql\`... between 1 and 5\`)`                                  |                                                           |

Ranges of numbers and enum-like values also get a `CHECK` constraint (cheap, and it
protects data written by future code paths); text lengths are enforced in the domain only.

Name constraints explicitly (`unique('users_email_key')`, `check('bookings_dates_check', ...)`):
the names are how `translateDbError` maps violations to domain errors.

Scope uniqueness to what the caller may know: the template's names are unique per owner
(`unique('sample_items_owner_id_name_key').on(table.ownerId, table.name)`), because a
global key would tell users which names other users have.

## Invariants belong in constraints

A check-then-insert in code is a race: two requests both see "free" and both insert.
Let Postgres decide atomically and translate the violation:

```ts
try {
  await this.db.tx.insert(users).values(row);
} catch (error) {
  throw translateDbError(error, { users_email_key: () => userEmailTaken(row.email) });
}
```

`translateDbError` also maps serialization failures/deadlocks to `ConcurrencyError` and
statement timeouts to `DependencyUnavailableError`; anything unmapped stays an internal
error. booking-service shows the strongest form: an exclusion constraint
(`EXCLUDE USING gist (house_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
WHERE (status = 'CONFIRMED')`) makes double booking impossible under any concurrency.

## Repositories

```ts
@Injectable()
export class DrizzleHouseRepository extends HouseRepository {
  constructor(private readonly db: DbContext) {
    super();
  } // value import of DbContext!

  async findById(id: string, options: { forUpdate?: boolean } = {}) {
    const query = this.db.tx.select().from(houses).where(eq(houses.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(filter: HouseFilter, { limit, after }: PageRequest) {
    const rows = await this.db.tx
      .select()
      .from(houses)
      .where(
        and(
          after ? lt(houses.id, after) : undefined,
          filter.ownerId ? eq(houses.ownerId, filter.ownerId) : undefined,
        ),
      )
      .orderBy(desc(houses.id))
      .limit(limit + 1); // one extra row tells toPage() there is a next page
    return toPage(rows.map(toDomain), limit);
  }
}
```

- `this.db.tx` is the current transaction inside `UnitOfWork.run()`, otherwise the pool.
- Map rows to aggregates with `X.restore(...)` and back with `toState()`; the repository is
  the only place that knows both shapes.
- Use the core query builder (`select/insert/update/delete`), not the relational query
  API: the core builder is the stable part of Drizzle 1.0 RC.
- Keyset pagination works because UUIDv7 ids sort by creation time. A filtered list
  (`WHERE owner_id = $1 AND id < $2 ORDER BY id DESC`) needs a composite `(filter, id)`
  index, e.g. `index('houses_owner_id_id_idx').on(table.ownerId, table.id)`.
- Lists of private data take the domain's typed scope as a required parameter
  (`list(scope: BookingScope, filter, page)`) and turn each kind into its WHERE clause
  (`guest` -> `guest_id = $1`, `host` -> `host_id = $1`, `all` -> no filter), each filtered
  kind backed by a `(column, id)` index (`bookings_guest_id_id_idx`, `bookings_host_id_id_idx`).
- Return `boolean` from deletes (`.returning({ id })`), let the use case raise `NotFound`.

## Migrations

```bash
pnpm --filter @ga/<svc> db:generate --name add_house_rating   # diff schema.ts -> SQL
pnpm --filter @ga/<svc> db:generate --custom --name no_overlap # empty file for hand SQL
pnpm --filter @ga/<svc> build && pnpm --filter @ga/<svc> db:migrate
pnpm db:migrate                                                  # all services
```

- Read the generated SQL before committing. On a rename, drizzle-kit (non-interactive)
  exits with code 2 and prints the `--hints` JSON to pass, so it never guesses a
  drop-and-add.
- Use a custom migration for what drizzle-kit cannot express: exclusion constraints,
  extensions (`create extension if not exists ... with schema public`), data backfills,
  triggers. Declare needed extensions in `services.json` (`"extensions": [...]`).
- Never edit or delete a migration that may have run anywhere; add a new one.
- Never use `drizzle-kit push` against shared databases.
- `runMigrations` (in `src/migrate.ts`) takes a Postgres advisory lock, so N replicas
  starting at once apply each migration exactly once, and sets `lock_timeout` (default
  5 s, option `lockTimeoutMs`) for the migration statements so a migration stuck behind
  live traffic fails instead of blocking it. Run it as a release step (a job before
  rollout), not from `main.ts`. Locally `pnpm db:migrate` / `pnpm stack:up` run it for
  every service with the stack's `DATABASE_URL`.
- All pending migrations run in one transaction. `CREATE INDEX CONCURRENTLY` cannot run
  there: do not use Drizzle's `.concurrently()`. Big-table indexes are a manual release
  step (`psql -c 'CREATE INDEX CONCURRENTLY ...'`) before the migration that declares the
  index with `IF NOT EXISTS`; there is no tooling for it yet.

### Adding a required column to a populated table

A generated `ADD COLUMN ... NOT NULL` without a default fails on any table that has rows,
and a made-up default hides missing data. Go **expand -> backfill -> contract**: add the
column nullable (code writes it from then on), backfill old rows with a batched one-off
job outside the migrator, then `SET NOT NULL` in a later migration. Recipes and lock
details: `references/zero-downtime.md`.

The one exception is booking-service's `host_id` (`drizzle/20261023063644_host_id`, ADR-0004).
It shipped before any real data existed, and the old rows could not be backfilled (bookings
of deleted houses have no owner left), so the migration starts with a hand-written guard
that refuses a populated table instead of migrating it:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bookings) THEN
    RAISE EXCEPTION 'bookings has rows from before ADR-0004 (no host_id): reset the dev database with pnpm db:setup --reset ga_booking --yes';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "host_id" uuid NOT NULL;
```

Do not copy it for data that matters: a guard turns the problem into a failed release, it
migrates nothing.

Changing a live schema without downtime (expand -> migrate -> contract):
`references/zero-downtime.md`.

## Configuration and pooling

`DATABASE_URL`, `DB_POOL_MAX` (default 10) and `DB_STATEMENT_TIMEOUT_MS` (default 5000)
are validated by the kit. Budget connections: replicas x `DB_POOL_MAX` per service must
stay below the server's `max_connections`; beyond that, put PgBouncer in front and keep
migrations on a direct connection. A `select 1` health check flips the service to
NOT_SERVING when the database is unreachable.

## Tests

Integration tests get a private schema with all migrations applied:
`createTestDatabase({ migrationsFolder })` from `@ga/service-kit/testing` (see `ga-testing`).
Never point tests at a service's real database.
