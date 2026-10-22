import { fileURLToPath } from 'node:url';
import { databaseConfigSchema, parseConfig, runMigrations } from '@ga/service-kit';
import { SERVICE } from './service.ts';

/** Release step: `pnpm db:migrate` (locally) or a one-off job before rollout (in clusters). */
const config = parseConfig(databaseConfigSchema);
await runMigrations({
  databaseUrl: config.DATABASE_URL,
  migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  lockKey: SERVICE.name,
});
console.log(`${SERVICE.name}: migrations applied`);
