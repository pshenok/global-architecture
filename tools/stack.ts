/**
 * Local stack lifecycle (PM2 + local Postgres).
 *   pnpm stack:up     build -> .env files -> certs + workload keys -> db:setup -> migrations -> PM2 -> wait until ready
 *   pnpm stack:down   stop and remove the PM2 processes
 *   pnpm db:migrate   apply every service's migrations (DATABASE_URL from services.json)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { ensureEnvFiles } from './env-files.ts';
import { databaseUrl, ROOT, readRegistry } from './lib.ts';

const run = (args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync(args[0] as string, args.slice(1), { cwd, env, stdio: 'inherit' });
};
const pm2 = (...args: string[]) => run(['pnpm', 'exec', 'pm2', ...args]);
/** CA of the services' gRPC certificates (created by tools/dev-certs.ts). */
const GRPC_CA = join(ROOT, '.certs/grpc-ca.pem');

/** Runs each service's built migrate.js with the DATABASE_URL the stack uses (not its .env). */
function migrateAll(): void {
  for (const service of readRegistry().services) {
    run([process.execPath, 'dist/migrate.js'], join(ROOT, service.dir), {
      ...process.env,
      DATABASE_URL: databaseUrl(service.database),
    });
  }
}

async function waitUntilReady(): Promise<boolean> {
  // Imported here, not at the top: on a fresh clone the kit is only built by the `up` step.
  const { checkGrpcHealth, closeHealthClients } = await import('@ga/service-kit');
  try {
    return await poll(checkGrpcHealth);
  } finally {
    closeHealthClients();
  }
}

async function poll(
  checkGrpcHealth: (url: string, options: { caFile: string }) => Promise<string>,
): Promise<boolean> {
  const { gateway, services } = readRegistry();
  const base = `https://localhost:${gateway.httpsPort}`;
  const dispatcher = new Agent({
    connect: { ca: readFileSync(join(ROOT, '.certs/dev-cert.pem')) },
  });
  const deadline = Date.now() + 60_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const health = await Promise.all(
        services.map(
          async (s) =>
            [
              s.name,
              await checkGrpcHealth(`localhost:${s.grpcPort}`, { caFile: GRPC_CA }),
            ] as const,
        ),
      );
      const notServing = health.filter(([, status]) => status !== 'SERVING');
      const response = await request(`${base}/readyz`, { dispatcher });
      const gatewayReady = response.statusCode === 200;
      const { identityProvider } = (await response.body.json()) as { identityProvider?: string };
      last = JSON.stringify({
        gatewayReady,
        identityProvider,
        services: Object.fromEntries(health),
      });
      // The gateway is ready before its IdP keys load (public routes work); the stack waits for both.
      if (gatewayReady && identityProvider === 'ok' && notServing.length === 0) {
        console.log(`\nstack ready: ${last}`);
        console.log(`\n  API      ${base}/v1/...`);
        console.log(`  Docs     ${base}/docs`);
        console.log(`  OpenAPI  ${base}/openapi.json`);
        for (const s of services)
          console.log(`  ${s.name.padEnd(16)} grpcs://localhost:${s.grpcPort}  (${s.grpcService})`);
        console.log('\n  pnpm stack:status | pnpm stack:logs | pnpm stack:down | pnpm test:e2e');
        return true;
      }
    } catch (error) {
      last = String(error);
    }
    await sleep(1_000);
  }
  console.error(
    `\nstack did not become ready within 60s; last state: ${last}\nsee: pnpm stack:logs`,
  );
  return false;
}

const command = process.argv[2];
switch (command) {
  case 'down':
    pm2('delete', 'ecosystem.config.cjs');
    break;
  case 'migrate':
    migrateAll();
    break;
  case 'up': {
    run(['pnpm', 'turbo', 'run', 'build']);
    const created = ensureEnvFiles();
    if (created.length > 0) console.log(`created ${created.join(', ')} from .env.example`);
    run([process.execPath, 'tools/dev-certs.ts']);
    run([process.execPath, 'tools/dev-keys.ts']);
    run([process.execPath, 'tools/db-setup.ts']);
    migrateAll();
    pm2('startOrReload', 'ecosystem.config.cjs', '--update-env');
    const ready = await waitUntilReady();
    process.exit(ready ? 0 : 1);
    break;
  }
  default:
    console.error('usage: node tools/stack.ts up|down|migrate');
    process.exit(1);
}
