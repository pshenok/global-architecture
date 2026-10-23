/**
 * Access guardrails (ADR-0004), run by `pnpm lint`:
 * 1. Every endpoint reachable without a signed-in user (@Access.public on a gRPC
 *    method; @Public or @AllowUnregistered at the gateway) is listed, with the same
 *    reason, in security/public-endpoints.json, which CODEOWNERS protects. Making
 *    something public is therefore always a visible, reviewed change.
 * 2. Verified actors are never forged: no `as UserActor` (or Identity/Service) casts
 *    outside the service kit and tests.
 * 3. Identity metadata is never hand-built: the x-ga-caller / x-ga-principal keys
 *    appear only in the service kit and tests.
 * 4. Test helpers (@ga/kernel/testing, @ga/service-kit/testing) stay out of production code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './lib.ts';

interface Entry {
  readonly where: string;
  readonly access: 'public' | 'unregistered';
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

const isTest = (file: string) =>
  file.endsWith('.spec.ts') || /(^|\/)test\//.test(file) || file.includes('/testing/');
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
        const declared =
          /@Access\.public\(\s*'([^']*)'\s*\)/.exec(line) ??
          /@Public\(\s*'([^']*)'\s*\)/.exec(line);
        if (declared) {
          found.push({
            where: `${file}#${memberAfter(lines, index)}`,
            access: 'public',
            reason: declared[1] as string,
          });
        }
        if (/@AllowUnregistered\(\s*\)/.test(line)) {
          found.push({
            where: `${file}#${memberAfter(lines, index)}`,
            access: 'unregistered',
            reason: 'registration',
          });
        }
      }
      if (isTest(file) || isAuthCode(file)) return;
      if (/\bas\s+(unknown\s+as\s+)?(UserActor|IdentityActor|ServiceActor)\b/.test(line)) {
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
  `check-access: ${found.length} public endpoint(s), all listed; no forged actors or identity metadata`,
);
