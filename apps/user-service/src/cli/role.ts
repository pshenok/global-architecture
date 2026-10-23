/**
 * Grants or revokes a platform role (ADR-0004). Roles live in user-service, never in the
 * identity provider. Runs against this service's own database, like migrate.ts:
 *   pnpm users:grant-role <userId> admin [--by <name>]       (repo root, local stack)
 *   pnpm users:revoke-role <userId> admin [--by <name>]
 *   node dist/cli/role.js grant|revoke <userId> admin --by <name>   (DATABASE_URL set)
 * A change reaches requests once the gateways' identity caches refresh: within
 * IDENTITY_CACHE_TTL_S (60 s), or IDENTITY_CACHE_STALE_IF_ERROR_S (5 min) while
 * user-service is unreachable from a gateway. Restart the gateways for an immediate
 * revoke. Each change prints one line naming who made it (`--by`, else the OS user the
 * CLI runs as); that line is the only record, so keep it (job log, ticket).
 */
import { createPool, databaseConfigSchema, parseConfig } from '@ga/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SERVICE } from '../service.ts';
import { changedBy, changeRole, parseRoleChange } from './role-change.ts';

const change = parseRoleChange(process.argv.slice(2));
if (!change) {
  console.error('usage: role.js grant|revoke <userId> <role> [--by <name>]');
  process.exit(1);
}
// Before the transaction: nothing may fail once the change has committed.
const by = changedBy(change.by);

const pool = createPool(parseConfig(databaseConfigSchema), `${SERVICE.name}:${change.action}-role`);
try {
  const roles = await changeRole(drizzle({ client: pool }), change);
  console.log(
    `${SERVICE.name}: ${change.action} ${change.role} for user ${change.userId} by ${by}; roles now [${roles.join(', ')}]`,
  );
} finally {
  await pool.end();
}
