/**
 * CI guard against template rot: generates a throwaway multi-word service from
 * templates/service, then typechecks, lints, tests and builds it, and removes it.
 *   pnpm template:verify   (needs Postgres: `pnpm db:setup`)
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const NAME = 'zz-template-check';
const PACKAGE = `@ga/${NAME}-service`;
const run = (args: string[]) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync(args[0] as string, args.slice(1), { cwd: ROOT, stdio: 'inherit' });
};

const status = () =>
  execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (line) => line && !line.includes(`${NAME}-service`) && !line.includes('zz_template_check'),
    )
    .sort()
    .join('\n');
const before = status();

let failed = false;
try {
  run([process.execPath, 'tools/new-service.ts', NAME, '--no-register', '--port', '59999']);
  run([
    'pnpm',
    'exec',
    'biome',
    'ci',
    `apps/${NAME}-service`,
    'packages/contracts/proto/ga/zz_template_check',
  ]);
  run(['pnpm', '--filter', PACKAGE, 'typecheck']);
  run(['pnpm', '--filter', PACKAGE, 'lint']);
  run(['pnpm', '--filter', PACKAGE, 'test']);
  run(['pnpm', 'turbo', 'run', 'build', `--filter=${PACKAGE}...`]);
  console.log('\ntemplate:verify OK');
} catch {
  failed = true;
  console.error('\ntemplate:verify FAILED');
} finally {
  rmSync(join(ROOT, 'apps', `${NAME}-service`), { recursive: true, force: true });
  rmSync(join(ROOT, 'packages/contracts/proto/ga/zz_template_check'), {
    recursive: true,
    force: true,
  });
  run(['pnpm', '--filter', '@ga/contracts', 'codegen']);
  run(['pnpm', 'install', '--prefer-offline', '--no-frozen-lockfile']);
}
const after = status();
if (after !== before) {
  console.error(`\ntemplate:verify left changes behind:\n${after}\n(before:\n${before})`);
  failed = true;
}
process.exit(failed ? 1 : 0);
