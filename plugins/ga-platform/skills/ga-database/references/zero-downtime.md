# Zero-downtime schema changes (expand, migrate, contract)

During a rolling deploy, old and new versions of a service run at the same time against
the same database. Every migration must work with both. Split breaking changes across
releases:

| Change                           | Release 1 (expand)                                                                         | Release 2 (migrate)                                                             | Release 3 (contract) |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------- |
| Add a required column            | add it nullable or with a default                                                          | code writes it; backfill in a custom migration in small batches                 | add `NOT NULL`       |
| Rename a column                  | add the new column; code writes both                                                       | backfill; code reads the new one                                                | drop the old column  |
| Drop a column                    | stop reading and writing it in code                                                        |                                                                                 | drop it              |
| Change a type                    | add a new column of the new type, dual-write                                               | backfill, switch reads                                                          | drop the old one     |
| Add a unique or check constraint | clean the data first                                                                       | add the constraint `NOT VALID`, then `VALIDATE CONSTRAINT` in a later migration |                      |
| Add an index on a big table      | `CREATE INDEX CONCURRENTLY` in its own release step (not inside the migration transaction) |                                                                                 |                      |
| Add an enum-like value           | add it to the `check` constraint before any code writes it                                 |                                                                                 |                      |

Rules of thumb:
- Never rename or drop in the same release that stops using a column.
- Backfills are idempotent and batched (`UPDATE ... WHERE id IN (SELECT id ... LIMIT 1000)`),
  run as custom migrations or one-off jobs, never inside request handling.
- Keep `DB_STATEMENT_TIMEOUT_MS` low for the service and give migrations their own
  connection with a `lock_timeout`, so a migration that waits for a lock fails fast
  instead of blocking production traffic.
- Proto contracts follow the same idea: add, migrate callers, then remove (see
  `ga-grpc-contracts`).
