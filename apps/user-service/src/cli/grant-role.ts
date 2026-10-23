/**
 * Grants a platform role (ADR-0004). Roles live in user-service, never in the identity
 * provider. Runs against this service's own database, like migrate.ts:
 *   pnpm users:grant-role <userId> admin                 (repo root, local stack)
 *   node dist/cli/grant-role.js <userId> admin           (with DATABASE_URL set)
 * The change reaches requests once the gateway's identity cache refreshes (<= 60 s).
 */
import type { Role } from '@ga/kernel';
import { createPool, databaseConfigSchema, parseConfig } from '@ga/service-kit';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { User } from '../domain/user.ts';
import { users } from '../infrastructure/persistence/schema.ts';
import { SERVICE } from '../service.ts';

const [userId, role] = process.argv.slice(2);
if (!userId || !role) {
  console.error('usage: grant-role <userId> <role>');
  process.exit(1);
}

const pool = createPool(parseConfig(databaseConfigSchema), `${SERVICE.name}:grant-role`);
try {
  await drizzle({ client: pool }).transaction(async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!row) throw new Error(`user ${userId} not found`);
    const user = User.restore({ ...row, roles: row.roles as Role[] });
    user.grantRole(role, new Date());
    const { roles, updatedAt } = user.toState();
    await tx
      .update(users)
      .set({ roles: [...roles], updatedAt })
      .where(eq(users.id, userId));
  });
  console.log(`${SERVICE.name}: user ${userId} now has role ${role}`);
} finally {
  await pool.end();
}
