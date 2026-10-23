/**
 * Access guardrails (ADR-0004), run by `pnpm lint`:
 * 1. Every endpoint that does not need a signed-in user is listed, with the same
 *    reason, in security/public-endpoints.json, which CODEOWNERS protects: @Access.public
 *    and @Public (anyone), @AllowUnregistered and @Access.identity (a login without a
 *    user), @Access.service (other workloads only). Opening one up is therefore always
 *    a visible, reviewed change. Decorator arguments must be inline literals on the
 *    decorator's line (any quote style); anything else fails, so it cannot hide.
 * 2. Verified actors are never forged: no `as UserActor` / `as Actor` (also through
 *    `as unknown as`, or `<UserActor>x`) outside the service kit and tests. `any`
 *    is already refused by Biome (noExplicitAny).
 * 3. Identity metadata is never hand-built: the x-ga-caller / x-ga-principal keys
 *    appear only in the service kit and tests.
 * 4. Test helpers (@ga/kernel/testing, @ga/service-kit/testing) stay out of production code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './lib.ts';

interface Entry {
  readonly where: string;
  readonly access: 'public' | 'unregistered' | 'identity' | 'service';
  readonly reason: string;
}

const LIST = join(ROOT, 'security/public-endpoints.json');
const SCANNED = ['apps', 'packages', 'templates', 'tools'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'gen', '.turbo', 'coverage']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

/** Specs, the test folders of apps/packages/the template, and the published test helpers. */
const isTest = (file: string) =>
  file.endsWith('.spec.ts') ||
  /^(apps\/[^/]+|packages\/[^/]+|templates\/service)\/test\//.test(file) ||
  file.startsWith('packages/service-kit/src/testing/') ||
  file === 'packages/kernel/src/testing.ts';
/** The service kit owns identity metadata and actor construction. */
const isAuthCode = (file: string) =>
  file.startsWith('packages/service-kit/src/') || file === 'packages/kernel/src/testing.ts';
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

/** The member a decorator applies to: the next method or class declared below it. */
function memberAfter(lines: readonly string[], index: number): string {
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const method = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (method && !line.trim().startsWith('@')) return method[1] as string;
    const cls = /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (cls) return cls[1] as string;
  }
  return '(unknown)';
}

const ACTOR_TYPES = '(?:Actor|UserActor|IdentityActor|ServiceActor)';
const FORGED_ACTOR = new RegExp(
  `\\bas\\s+(?:unknown\\s+as\\s+)?${ACTOR_TYPES}\\b|(?<![\\w$])<${ACTOR_TYPES}>`,
);
const STRING = String.raw`(['"\`])((?:(?!\1).)*)\1`;
const PUBLIC = new RegExp(
  String.raw`@(?:Access\.public|Public)\s*\(\s*${STRING}\s*(?:,\s*\{[^}]*\}\s*)?\)`,
);
const NAMES = String.raw`\[\s*((?:(['"\`])[\w-]+\2\s*,?\s*)*)\]`;
const IDENTITY = new RegExp(
  String.raw`@Access\.identity\s*\(\s*(?:\{\s*via\s*:\s*${NAMES}\s*\}\s*)?\)`,
);
const SERVICE = new RegExp(String.raw`@Access\.service\s*\(\s*${NAMES}\s*\)`);
const names = (list: string | undefined) =>
  (list ?? '')
    .split(',')
    .map((name) => name.trim().slice(1, -1))
    .filter(Boolean)
    .join(', ');

/** The access a decorator on this line opens up, `unreadable` when it cannot be read. */
function declaredAccess(line: string): Pick<Entry, 'access' | 'reason'> | 'unreadable' | undefined {
  if (/@(Access\.public|Public)\s*\(/.test(line)) {
    const match = PUBLIC.exec(line);
    return match ? { access: 'public', reason: match[2] as string } : 'unreadable';
  }
  if (/@AllowUnregistered\s*\(/.test(line))
    return { access: 'unregistered', reason: 'registration' };
  if (/@Access\.identity\s*\(/.test(line)) {
    const match = IDENTITY.exec(line);
    if (!match) return 'unreadable';
    const via = names(match[1]);
    return {
      access: 'identity',
      reason: via ? `login without a user, via ${via}` : 'login without a user',
    };
  }
  if (/@Access\.service\s*\(/.test(line)) {
    const match = SERVICE.exec(line);
    return match ? { access: 'service', reason: `workloads: ${names(match[1])}` } : 'unreadable';
  }
  return undefined;
}

const found: Entry[] = [];
const problems: string[] = [];

for (const top of SCANNED) {
  for (const path of sourceFiles(join(ROOT, top))) {
    const file = relative(ROOT, path);
    if (file === 'tools/check-access.ts') continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      const at = `${file}:${index + 1}`;
      if (!isTest(file)) {
        const declared = declaredAccess(line);
        if (declared === 'unreadable') {
          problems.push(
            `${at}: write this access decorator with inline literal arguments on one line`,
          );
        } else if (declared) {
          found.push({ where: `${file}#${memberAfter(lines, index)}`, ...declared });
        }
      }
      // Tests and local dev tools (tools/) may sign tokens and build metadata on purpose.
      if (isTest(file) || isAuthCode(file) || file.startsWith('tools/')) return;
      if (FORGED_ACTOR.test(line)) {
        problems.push(
          `${at}: casts to a verified actor; take actors from currentUser() / currentActor()`,
        );
      }
      if (/['"`]x-ga-(caller|principal)['"`]/.test(line)) {
        problems.push(
          `${at}: builds identity metadata by hand; the service kit sets it on every call`,
        );
      }
      if (/from\s+['"]@ga\/(kernel|service-kit)\/testing['"]/.test(line)) {
        problems.push(`${at}: imports a test helper into production code`);
      }
    });
  }
}

const listed = (JSON.parse(readFileSync(LIST, 'utf8')) as { endpoints: Entry[] }).endpoints;
const key = (entry: Entry) => `${entry.where} [${entry.access}] ${entry.reason}`;
const listedKeys = new Set(listed.map(key));
const foundKeys = new Set(found.map(key));
for (const entry of found) {
  if (!listedKeys.has(key(entry))) {
    problems.push(
      `${entry.where}: ${entry.access} access ("${entry.reason}") is not in security/public-endpoints.json`,
    );
  }
}
for (const entry of listed) {
  if (!foundKeys.has(key(entry))) {
    problems.push(
      `security/public-endpoints.json lists ${key(entry)}, which the code no longer declares`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `check-access: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `check-access: ${found.length} endpoint(s) open without a user, all listed; no forged actors or identity metadata`,
);
