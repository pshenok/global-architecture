/**
 * Local stack lifecycle (PM2 + local Postgres).
 *   pnpm stack:up     build -> certs -> db:setup -> migrations -> pm2 start -> wait for /readyz
 *   pnpm stack:down   stop and remove the PM2 processes
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, request } from 'undici';
import { ROOT, readRegistry } from './lib.ts';

const run = (args: string[]) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync(args[0] as string, args.slice(1), { cwd: ROOT, stdio: 'inherit' });
};
const pm2 = (...args: string[]) => run(['pnpm', 'exec', 'pm2', ...args]);

const command = process.argv[2];
if (command === 'down') {
  pm2('delete', 'ecosystem.config.cjs');
  process.exit(0);
}
if (command !== 'up') {
  console.error('usage: node tools/stack.ts up|down');
  process.exit(1);
}

run(['pnpm', 'turbo', 'run', 'build']);
run(['node', 'tools/dev-certs.ts']);
run(['node', 'tools/db-setup.ts']);
run(['pnpm', 'turbo', 'run', 'db:migrate']);
pm2('startOrReload', 'ecosystem.config.cjs', '--update-env');

const { gateway, services } = readRegistry();
const base = `https://localhost:${gateway.httpsPort}`;
const dispatcher = new Agent({ connect: { ca: readFileSync(join(ROOT, '.certs/dev-cert.pem')) } });
const deadline = Date.now() + 60_000;
let last = 'no response';
while (Date.now() < deadline) {
  try {
    const response = await request(`${base}/readyz`, { dispatcher });
    last = JSON.stringify(await response.body.json());
    if (response.statusCode === 200) {
      console.log(`\nstack ready: ${last}`);
      console.log(`\n  API      ${base}/v1/...`);
      console.log(`  Docs     ${base}/docs`);
      console.log(`  OpenAPI  ${base}/openapi.json`);
      for (const s of services)
        console.log(`  ${s.name.padEnd(16)} grpc://127.0.0.1:${s.grpcPort}  (${s.grpcService})`);
      console.log('\n  pnpm stack:status | pnpm stack:logs | pnpm stack:down | pnpm test:e2e');
      process.exit(0);
    }
  } catch (error) {
    last = String(error);
  }
  await sleep(1_000);
}
console.error(
  `\nstack did not become ready within 60s; last /readyz: ${last}\nsee: pnpm stack:logs`,
);
process.exit(1);
