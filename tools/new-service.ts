/**
 * Scaffolds a new gRPC service from templates/service.
 *
 *   pnpm new:service <name> [--plural <name>] [--port <n>] [--no-register] [--skip-install]
 *
 * <name> is the kebab-case domain noun, e.g. `house` or `payment-method`.
 * Creates apps/<name>-service, the contract packages/contracts/proto/ga/<name>/v1/<name>.proto,
 * an initial migration, a .env, and registers ports/databases in services.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { readRegistry, ROOT, type ServiceEntry, writeRegistry } from './lib.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plural: { type: 'string' },
    port: { type: 'string' },
    'no-register': { type: 'boolean', default: false },
    'skip-install': { type: 'boolean', default: false },
  },
});

const KEBAB = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const name = positionals[0];
if (!name || !KEBAB.test(name) || name.endsWith('-service')) {
  console.error('usage: pnpm new:service <kebab-case-noun> (e.g. house, payment-method; without "-service")');
  process.exit(1);
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const words = name.split('-');
const pluralWords = values.plural
  ? values.plural.split('-')
  : [...words.slice(0, -1), pluralize(words.at(-1) as string)];
if (values.plural && !KEBAB.test(values.plural)) {
  console.error('--plural must be kebab-case');
  process.exit(1);
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const forms = (ws: string[]) => ({
  kebab: ws.join('-'),
  snake: ws.join('_'),
  camel: (ws[0] as string) + ws.slice(1).map(capitalize).join(''),
  pascal: ws.map(capitalize).join(''),
  upper: ws.join('_').toUpperCase(),
  spaced: ws.join(' '),
});
const singular = forms(words);
const plural = forms(pluralWords);
const TEMPLATE = { singular: forms(['sample', 'item']), plural: forms(['sample', 'items']) };

// Plural forms first: they contain the singular forms as prefixes.
const replacements: [string, string][] = [];
for (const key of ['kebab', 'snake', 'camel', 'pascal', 'upper', 'spaced'] as const) {
  replacements.push([TEMPLATE.plural[key], plural[key]]);
}
for (const key of ['kebab', 'snake', 'camel', 'pascal', 'upper', 'spaced'] as const) {
  replacements.push([TEMPLATE.singular[key], singular[key]]);
}

const registry = readRegistry();
const serviceName = `${singular.kebab}-service`;
const appDir = join(ROOT, 'apps', serviceName);
const protoRel = `ga/${singular.snake}/v1/${singular.snake}.proto`;
const protoPath = join(ROOT, 'packages/contracts/proto', protoRel);
const port = values.port
  ? Number(values.port)
  : Math.max(50050, ...registry.services.map((s) => s.grpcPort)) + 1;

if (existsSync(appDir)) throw new Error(`${relative(ROOT, appDir)} already exists`);
if (existsSync(protoPath)) throw new Error(`contract ${protoRel} already exists`);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid port ${values.port}`);
if (registry.services.some((s) => s.grpcPort === port)) throw new Error(`port ${port} is already used`);

const substitute = (text: string): string => {
  let out = text;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out
    .replaceAll('GRPC_PORT=50099', `GRPC_PORT=${port}`)
    .replaceAll('EXPOSE 50051', `EXPOSE ${port}`);
};

const templateDir = join(ROOT, 'templates/service');
const files = (await readdir(templateDir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(templateDir, join(entry.parentPath, entry.name)))
  .filter((file) => !file.startsWith('proto/') && !file.startsWith('node_modules/') && !file.startsWith('dist/'));

for (const file of files) {
  const target = join(appDir, substitute(file));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, substitute(await readFile(join(templateDir, file), 'utf8')));
}
await writeFile(join(appDir, '.env'), await readFile(join(appDir, '.env.example'), 'utf8'));

await mkdir(dirname(protoPath), { recursive: true });
await writeFile(protoPath, substitute(await readFile(join(templateDir, 'proto/sample_item.proto'), 'utf8')));

const entry: ServiceEntry = {
  name: serviceName,
  dir: `apps/${serviceName}`,
  package: `@ga/${serviceName}`,
  grpcPort: port,
  database: `ga_${singular.snake}`,
  grpcService: `ga.${singular.snake}.v1.${singular.pascal}Service`,
  protoFile: protoRel,
  urlEnv: `${singular.upper}_SERVICE_URL`,
};
if (!values['no-register']) {
  registry.services.push(entry);
  writeRegistry(registry);
}

const run = (command: string, args: string[]) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
};
if (!values['skip-install']) {
  run('pnpm', ['install', '--prefer-offline']);
  run('pnpm', ['--filter', '@ga/contracts', 'codegen']);
  run('pnpm', ['--filter', entry.package, 'db:generate', '--name', 'init']);
}

console.log(`
Created ${entry.package}
  service   ${entry.dir}
  contract  packages/contracts/proto/${protoRel}
  gRPC      ${entry.grpcService} on :${port}
  database  ${entry.database}

Next:
  1. Model the domain: src/domain/${singular.kebab}.ts, then the contract, schema.ts and use cases.
  2. pnpm --filter @ga/contracts codegen          (after editing the .proto)
  3. pnpm --filter ${entry.package} db:generate   (after editing schema.ts)
  4. pnpm db:setup && pnpm --filter ${entry.package} test
`);
