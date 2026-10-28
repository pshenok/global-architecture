/**
 * Operator commands of the event bus (ADR-0005), against its own database like migrate.ts:
 *   pnpm events:status                                         (repo root, local stack)
 *   pnpm events:redrive --subscriber <workload> [--type <fqn>]
 *   pnpm events:replay --subscriber <workload> --type <fqn> --since <ISO time>
 *   pnpm events:drop --subscriber <workload> --type <fqn>
 *   node dist/cli/bus.js status|redrive|replay|drop ...           (DATABASE_URL set)
 * Each change prints one line; keep it (job log, ticket), it is the only record.
 * It boots no service (no gRPC server, no retention timer): it builds EventBusAdmin on the
 * backend's EventBrokerAdmin itself. Its imports use erasable TypeScript only, so
 * `node src/cli/bus.ts` also runs it from source (with built workspace packages).
 */
import { parseArgs } from 'node:util';
import { createPool, databaseConfigSchema, parseConfig, SystemClock } from '@ga/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EventBusAdmin } from '../application/event-bus-admin.ts';
import { MAX_RETENTION_DAYS } from '../domain/retention.ts';
import { PostgresEventBrokerAdmin } from '../infrastructure/persistence/postgres-event-broker-admin.ts';
import { SERVICE } from '../service.ts';
import { parseSince } from './parse-since.ts';

const USAGE = `usage: bus.js status
       bus.js redrive --subscriber <workload> [--type <fqn>]
       bus.js replay --subscriber <workload> --type <fqn> --since <ISO time>
       bus.js drop --subscriber <workload> --type <fqn>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    subscriber: { type: 'string' },
    type: { type: 'string' },
    since: { type: 'string' },
  },
});
const command = positionals[0];
const since = parseSince(values.since);
if (
  !(
    command === 'status' ||
    (command === 'redrive' && values.subscriber && values.type !== '') ||
    (command === 'replay' && values.subscriber && values.type && since) ||
    (command === 'drop' && values.subscriber && values.type)
  )
) {
  console.error(USAGE);
  process.exit(1);
}

const pool = createPool(parseConfig(databaseConfigSchema), `${SERVICE.name}:cli-${command}`);
try {
  const admin = new EventBusAdmin(
    new PostgresEventBrokerAdmin(drizzle({ client: pool })),
    new SystemClock(),
  );
  if (command === 'status') {
    const rows = await admin.status();
    if (rows.length === 0) console.log('no pending or dead deliveries');
    else console.table(rows);
  } else if (command === 'redrive') {
    const subscriber = values.subscriber as string;
    const { redriven, skipped } = await admin.redrive({ subscriber, type: values.type });
    console.log(
      `${SERVICE.name}: redrove ${redriven} dead letter(s) of ${subscriber}${values.type ? ` (${values.type})` : ''}${skipped > 0 ? `, skipped ${skipped} of types the catalog does not list for it (events:status, events:drop)` : ''}`,
    );
  } else if (command === 'drop') {
    const target = { subscriber: values.subscriber as string, type: values.type as string };
    const count = await admin.drop(target);
    console.log(
      `${SERVICE.name}: dropped ${count} delivery row(s) of ${target.type} for ${target.subscriber}`,
    );
  } else {
    const target = {
      subscriber: values.subscriber as string,
      type: values.type as string,
      since: since as Date,
    };
    const { queued, skipped } = await admin.replay(target);
    console.log(
      `${SERVICE.name}: queued ${queued} ${target.type} event(s) since ${target.since.toISOString()} for ${target.subscriber}${skipped > 0 ? `, skipped ${skipped} older than ${MAX_RETENTION_DAYS} days (too old to replay safely)` : ''}`,
    );
  }
} finally {
  await pool.end();
}
