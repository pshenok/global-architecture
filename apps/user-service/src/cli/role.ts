/**
 * Grants or revokes a platform role (ADR-0004). Roles live in user-service, never in the
 * identity provider. Runs against this service's own database, like migrate.ts:
 *   pnpm users:grant-role <userId> admin                 (repo root, local stack)
 *   pnpm users:revoke-role <userId> admin
 *   node dist/cli/role.js grant|revoke <userId> admin    (with DATABASE_URL set)
 * A change reaches requests once the gateways' identity caches refresh: within
 * IDENTITY_CACHE_TTL_S (60 s), or IDENTITY_CACHE_STALE_IF_ERROR_S (5 min) while
 * user-service is unreachable from a gateway. Restart the gateways for an immediate
 * revoke. Every change is printed with the operator's OS user, for the audit trail.
 */
import { userInfo } from 'node:os';
import type { Role } from '@ga/kernel';
import { createPool, databaseConfigSchema, parseConfig } from '@ga/service-kit';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { User } from '../domain/user.ts';
import { users } from '../infrastructure/persistence/schema.ts';
import { SERVICE } from '../service.ts';

const [action, userId, role] = process.argv.slice(2);
if ((action !== 'grant' && action !== 'revoke') || !userId || !role) {
  console.error('usage: role.js grant|revoke <userId> <role>');
  process.exit(1);
}

const pool = createPool(parseConfig(databaseConfigSchema), `${SERVICE.name}:${action}-role`);
try {
  const roles = await drizzle({ client: pool }).transaction(async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!row) throw new Error(`user ${userId} not found`);
    const user = User.restore({ ...row, roles: row.roles as Role[] });
    if (action === 'grant') user.grantRole(role, new Date());
    else user.revokeRole(role, new Date());
    const state = user.toState();
    await tx
      .update(users)
      .set({ roles: [...state.roles], updatedAt: state.updatedAt })
      .where(eq(users.id, userId));
    return state.roles;
  });
  console.log(
    `${SERVICE.name}: ${action} ${role} for user ${userId} by ${userInfo().username}; roles now [${roles.join(', ')}]`,
  );
} finally {
  await pool.end();
}
