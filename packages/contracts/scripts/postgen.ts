/**
 * Post-processes ts-proto output so it is valid Node ESM under verbatimModuleSyntax.
 *
 * 1. ts-proto (nestJs + useDate) emits `import { wrappers } from "protobufjs"` plus a
 *    Timestamp wrapper block. Under Node ESM that import crashes (protobufjs is CJS),
 *    and it would patch an arbitrary protobufjs copy anyway. We strip it; the runtime
 *    installs correct wrappers via `installWellKnownTypes()`.
 * 2. In nestJs mode messages are interfaces only, but ts-proto still imports
 *    cross-file messages as values (`import { Money } from "../../common/v1/money.js"`).
 *    Under ESM that is a link-time crash ("does not provide an export named Money").
 *    We turn every imported interface/type into `import type`, keeping real values
 *    (enums, consts, functions) as value imports.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = new URL('../src/gen/', import.meta.url).pathname;
const WRAPPERS_IMPORT = /^import \{ wrappers \} from "protobufjs";\n/m;
const WRAPPERS_BLOCK =
  /^wrappers\["\.google\.protobuf\.(Timestamp|Struct)"\] = \{[\s\S]*?\n\} as any;\n/gm;
const RELATIVE_IMPORT = /^import \{ ([^}]+) \} from "(\.{1,2}\/[^"]+)\.js";$/gm;

const typeOnlyExports = new Map<string, Set<string>>();

async function typeExportsOf(file: string): Promise<Set<string>> {
  const cached = typeOnlyExports.get(file);
  if (cached) return cached;
  const source = await readFile(file, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/^export (?:interface|type) (\w+)/gm)) {
    if (match[1]) names.add(match[1]);
  }
  typeOnlyExports.set(file, names);
  return names;
}

const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.ts'));
let changed = 0;

for (const file of files) {
  const path = join(root, file);
  const source = await readFile(path, 'utf8');
  let output = source.replace(WRAPPERS_IMPORT, '').replace(WRAPPERS_BLOCK, '');

  const replacements: [string, string][] = [];
  for (const match of output.matchAll(RELATIVE_IMPORT)) {
    const [statement, list, specifier] = match;
    if (!list || !specifier) continue;
    const target = resolve(dirname(path), `${specifier}.ts`);
    const types = await typeExportsOf(target);
    const names = list
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const typeNames = names.filter((n) => types.has(n));
    const valueNames = names.filter((n) => !types.has(n));
    const lines: string[] = [];
    if (typeNames.length > 0)
      lines.push(`import type { ${typeNames.join(', ')} } from "${specifier}.js";`);
    if (valueNames.length > 0)
      lines.push(`import { ${valueNames.join(', ')} } from "${specifier}.js";`);
    replacements.push([statement, lines.join('\n')]);
  }
  for (const [from, to] of replacements) output = output.replace(from, to);

  if (/\bwrappers\b/.test(output.replace(/\/\/.*$/gm, ''))) {
    throw new Error(`postgen: unhandled protobufjs wrappers usage left in ${file}`);
  }
  if (output !== source) {
    await writeFile(path, output);
    changed += 1;
  }
}
console.log(`postgen: rewrote ${changed} of ${files.length} file(s)`);
