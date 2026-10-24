/**
 * Operator commands of the event bus (ADR-0005), against its own database like migrate.ts:
 *   pnpm events:status                                         (repo root, local stack)
 *   pnpm events:redrive --subscriber <workload> [--type <fqn>]
 *   pnpm events:replay --subscriber <workload> --type <fqn> --since <ISO time>
 *   node dist/cli/bus.js status|redrive|replay ...                (DATABASE_URL set)
 * Each change prints one line; keep it (job log, ticket), it is the only record.
 */
import { parseArgs } from 'node:util';
import { createPool, databaseConfigSchema, parseConfig } from '@ga/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SERVICE } from '../service.ts';
import { redrive, replay, status } from './bus-admin.ts';

const USAGE = `usage: bus.js status
       bus.js redrive --subscriber <workload> [--type <fqn>]
       bus.js replay --subscriber <workload> --type <fqn> --since <ISO time>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    subscriber: { type: 'string' },
    type: { type: 'string' },
    since: { type: 'string' },
  },
});
const command = positionals[0];
const since = values.since ? new Date(values.since) : undefined;
if (
  !(
    command === 'status' ||
    (command === 'redrive' && values.subscriber) ||
    (command === 'replay' &&
      values.subscriber &&
      values.type &&
      since &&
      !Number.isNaN(since.getTime()))
  )
) {
  console.error(USAGE);
  process.exit(1);
}

const pool = createPool(parseConfig(databaseConfigSchema), `${SERVICE.name}:cli-${command}`);
try {
  const db = drizzle({ client: pool });
  if (command === 'status') {
    const rows = await status(db);
    if (rows.length === 0) console.log('no pending or dead deliveries');
    else console.table(rows);
  } else if (command === 'redrive') {
    const subscriber = values.subscriber as string;
    const count = await redrive(db, { subscriber, type: values.type });
    console.log(
      `${SERVICE.name}: redrove ${count} dead letter(s) of ${subscriber}${values.type ? ` (${values.type})` : ''}`,
    );
  } else {
    const target = {
      subscriber: values.subscriber as string,
      type: values.type as string,
      since: since as Date,
    };
    const count = await replay(db, target);
    console.log(
      `${SERVICE.name}: queued ${count} ${target.type} event(s) since ${target.since.toISOString()} for ${target.subscriber}`,
    );
  }
} finally {
  await pool.end();
}
