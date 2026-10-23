/**
 * Access guardrails (ADR-0004), run by `pnpm lint`:
 * 1. Every endpoint that does not need a signed-in user is listed, with the same
 *    reason, in security/public-endpoints.json, which CODEOWNERS protects: @Access.public
 *    and @Public (anyone), @AllowUnregistered and @Access.identity (a login without a
 *    user), @Access.service (other workloads only). Opening one up is therefore always
 *    a visible, reviewed change. Only the direct form is read: the decorator written on
 *    the method or class it opens, with inline literal arguments on its line (any quote
 *    style). Everything else fails: a decorator whose member cannot be told, any other
 *    use of these names (a wrapper, an alias, a decorator kept in a constant, a renamed
 *    or namespace import) and any use of their metadata keys (SetMetadata,
 *    Reflect.defineMetadata). The same list is also checked against the metadata the
 *    apps really carry (startTestService for services, the gateway's
 *    public-endpoints.spec.ts), which no spelling escapes.
 * 2. Verified actors are never forged outside the service kit and tests: no cast to an
 *    actor type (`as UserActor`, `as unknown as Actor`, `<UserActor>x`) and no actor type
 *    argument to a call (`cast<UserActor>(...)`). Explicit `any` fails Biome
 *    (noExplicitAny) and implicit `any` (JSON.parse, ...) fails oxlint (no-unsafe-*), so
 *    request data cannot become an actor without a cast either. A generic helper that
 *    returns `value as T` defeats any lint; the brand makes it a deliberate act that
 *    review has to catch.
 * 3. Identity metadata is never hand-built: the x-ga-caller / x-ga-principal keys
 *    appear only in the service kit and tests.
 * 4. Test helpers (@ga/kernel/testing, @ga/service-kit/testing, any `testing` module)
 *    stay out of production code: not imported, re-exported, import()ed or required.
 * 5. Gateway routes are Nest controller routes, so the auth guard sees them: only the
 *    gateway's bootstrap.ts and http/openapi.ts (the /openapi.json and /docs pages) touch
 *    the raw Fastify instance or mount middleware.
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
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
/** Generated code (buf), skipped by its exact path: a hand-written `gen` folder is checked. */
const GENERATED = 'packages/contracts/src/gen';

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || relative(ROOT, path) === GENERATED) continue;
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
/** The service kit owns identity metadata, actor construction and the @Access decorators. */
const isKit = (file: string) => file.startsWith('packages/service-kit/src/');
/** Gateway files that define or read the route decorators' metadata. */
const GATEWAY_ACCESS_CODE = new Set([
  'apps/gateway/src/auth/decorators.ts',
  'apps/gateway/src/auth/auth.guard.ts',
  'apps/gateway/src/http/openapi.ts',
]);
/** Gateway files that may touch the raw Fastify instance (hooks, the docs pages). */
const GATEWAY_RAW_HTTP = new Set([
  'apps/gateway/src/bootstrap.ts',
  'apps/gateway/src/http/openapi.ts',
]);
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

const STRING = String.raw`(['"\`])((?:(?!\1).)*)\1`;
const PUBLIC = new RegExp(
  String.raw`@(?:Access\.public|Public)\s*\(\s*${STRING}\s*(?:,\s*\{[^}]*\}\s*)?\)`,
);
const NAMES = String.raw`\[\s*((?:(['"\`])[\w-]+\2\s*,?\s*)*)\]`;
const IDENTITY = new RegExp(
  String.raw`@Access\.identity\s*\(\s*(?:\{\s*via\s*:\s*${NAMES}\s*\}\s*)?\)`,
);
const SERVICE = new RegExp(String.raw`@Access\.service\s*\(\s*${NAMES}\s*\)`);
const UNREGISTERED = /@AllowUnregistered\s*\(\s*\)/;
/** @Access.user / @Access.admin need a user, so they open nothing; only their name is read. */
const USER = /@Access\.(?:user|admin)\b/g;
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
  if (/@AllowUnregistered\s*\(/.test(line)) {
    return UNREGISTERED.test(line)
      ? { access: 'unregistered', reason: 'registration' }
      : 'unreadable';
  }
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

/** Names of the access decorators and their metadata, and the keys they store under. */
const ACCESS_NAMES =
  /\b(?:Public|AllowUnregistered|Access|AUTH_ROUTE|ACCESS_POLICY|PUBLIC_EXTENSION|accessPolicyOf)\b/;
const ACCESS_KEYS = /(['"`])(?:ga:auth-route|ga:access-policy|x-ga-public)\1/;
/** Modules that export the access decorators. */
const ACCESS_MODULE = String.raw`['"](?:@ga\/service-kit|[^'"]*\/auth\/decorators(?:\.ts)?)['"]`;
const strings = /(['"`])(?:\\.|(?!\1).)*\1/g;

/**
 * What is left of a line once the direct access decorators and string literals are
 * removed; any access name still in it is an indirect use.
 */
const residue = (line: string) =>
  line
    .replace(PUBLIC, '')
    .replace(IDENTITY, '')
    .replace(SERVICE, '')
    .replace(UNREGISTERED, '')
    .replace(USER, '')
    .replace(strings, "''");

/** Import and export statements (possibly over several lines), by first and last line. */
function moduleStatements(text: string): { first: number; last: number; text: string }[] {
  const statements: { first: number; last: number; text: string }[] = [];
  const pattern =
    /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*['"][^'"]+['"][ \t]*;?/gm;
  for (const match of text.matchAll(pattern)) {
    const first = text.slice(0, match.index).split('\n').length - 1;
    statements.push({ first, last: first + match[0].split('\n').length - 1, text: match[0] });
  }
  return statements;
}

const DECLARATION =
  /^(?:(?:public|protected|private|static|override|readonly|async|abstract|declare|accessor|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*[<(]/;
const CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const CLASS_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

/** Index just past the decorator that starts at `start` (`@name.path(args)`), or -1. */
function skipDecorator(text: string, start: number): number {
  const head = /^@[A-Za-z_$][\w$.]*/.exec(text.slice(start));
  if (!head) return -1;
  let i = start + head[0].length;
  while (/\s/.test(text[i] ?? '')) i += 1;
  if (text[i] !== '(') return i;
  let depth = 0;
  for (; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < text.length && text[i] !== char; i += 1) if (text[i] === '\\') i += 1;
    } else if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The member a decorator on line `index` applies to: `Class.method`, or `Class` for a
 * decorator on a class. Only further decorators, blank lines and comments may come
 * between them; undefined when the declaration cannot be told.
 */
function memberAfter(lines: readonly string[], index: number): string | undefined {
  const text = lines.slice(index).join('\n');
  let at = (lines[index] as string).indexOf('@');
  while (at >= 0) {
    const end = skipDecorator(text, at);
    if (end < 0) return undefined;
    at = end;
    for (;;) {
      const rest = text.slice(at);
      const space = /^\s+/.exec(rest);
      const comment = /^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
      if (space) at += space[0].length;
      else if (comment) at += comment[0].length;
      else break;
    }
    if (text[at] !== '@') break;
  }
  const declaration = text.slice(at);
  const cls = CLASS.exec(declaration);
  if (cls) return cls[1];
  const method = DECLARATION.exec(declaration);
  if (!method) return undefined;
  for (let i = index; i >= 0; i -= 1) {
    const owner = CLASS_LINE.exec(lines[i] as string);
    if (owner) return `${owner[1]}.${method[1]}`;
  }
  return undefined;
}

const ACTOR_TYPES = '(?:Actor|UserActor|IdentityActor|ServiceActor)';
const FORGED_ACTOR = new RegExp(
  `\\bas\\s+(?:unknown\\s+as\\s+)?${ACTOR_TYPES}\\b|(?<![\\w$])<${ACTOR_TYPES}>`,
);
/** An actor type as a type argument of a call (`cast<UserActor>(...)`); `new X<...>()` is fine. */
const ACTOR_TYPE_ARGUMENT = new RegExp(
  `(?<!\\bnew\\s+[\\w$.]*)[\\w$)\\]]\\s*<[^<>()]*\\b${ACTOR_TYPES}\\b[^<>()]*>\\s*\\(`,
);
const TEST_HELPERS =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:@ga\/(?:kernel|service-kit)\/testing|\.{1,2}\/(?:[^'"]*\/)?testing(?:\.ts|\/[^'"]*)?)['"]/;

const found: Entry[] = [];
const problems: string[] = [];

for (const top of SCANNED) {
  for (const path of sourceFiles(join(ROOT, top))) {
    const file = relative(ROOT, path);
    if (file === 'tools/check-access.ts') continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const test = isTest(file);
    const definesAccess = isKit(file) || GATEWAY_ACCESS_CODE.has(file);
    const inStatement = new Set<number>();
    if (!test && !definesAccess) {
      for (const statement of moduleStatements(text)) {
        for (let i = statement.first; i <= statement.last; i += 1) inStatement.add(i);
        const at = `${file}:${statement.first + 1}`;
        if (/^\s*export\b/.test(statement.text) && ACCESS_NAMES.test(statement.text)) {
          problems.push(
            `${at}: re-exports an access decorator; import it from where it is defined`,
          );
        } else if (
          /^\s*export\s*\*/.test(statement.text) &&
          new RegExp(ACCESS_MODULE).test(statement.text)
        ) {
          problems.push(`${at}: re-exports the access decorators' module`);
        } else if (
          /\bimport\s*\*\s*as\b/.test(statement.text) &&
          new RegExp(ACCESS_MODULE).test(statement.text)
        ) {
          problems.push(
            `${at}: namespace import of the access decorators' module; import them by name`,
          );
        } else if (new RegExp(`${ACCESS_NAMES.source}\\s+as\\b`).test(statement.text)) {
          problems.push(`${at}: renames an access decorator on import; use its own name`);
        }
      }
    }
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      const at = `${file}:${index + 1}`;
      if (!test) {
        const declared = declaredAccess(line);
        if (declared === 'unreadable') {
          problems.push(
            `${at}: write this access decorator with inline literal arguments on one line`,
          );
        } else if (declared) {
          const member = memberAfter(lines, index);
          if (member) found.push({ where: `${file}#${member}`, ...declared });
          else
            problems.push(
              `${at}: cannot tell which method or class this access decorator opens; put it directly above the declaration`,
            );
        }
        if (!definesAccess && !inStatement.has(index)) {
          if (ACCESS_KEYS.test(line)) {
            problems.push(`${at}: uses an access metadata key; declare access with the decorators`);
          } else if (ACCESS_NAMES.test(residue(line))) {
            problems.push(
              `${at}: uses an access decorator indirectly (wrapper, alias, stored decorator, metadata); write @Public / @Access.<kind> directly on the method or class`,
            );
          } else if (
            /\b(?:import|require)\s*\(\s*['"][^'"]*\/auth\/decorators(?:\.ts)?['"]/.test(line)
          ) {
            problems.push(`${at}: loads the gateway's access decorators dynamically`);
          }
        }
        if (
          file.startsWith('apps/gateway/src/') &&
          !GATEWAY_RAW_HTTP.has(file) &&
          /\bgetHttpAdapter\s*\(|\bgetInstance\s*\(|\.\s*use\s*\(/.test(line)
        ) {
          problems.push(
            `${at}: touches the raw HTTP server; gateway routes are controller routes so the auth guard sees them`,
          );
        }
      }
      // Tests and local dev tools (tools/) may sign tokens and build metadata on purpose.
      if (test || file.startsWith('tools/')) return;
      if (TEST_HELPERS.test(line)) {
        problems.push(`${at}: loads a test helper in production code`);
      }
      if (isKit(file)) return;
      if (FORGED_ACTOR.test(line) || ACTOR_TYPE_ARGUMENT.test(line)) {
        problems.push(
          `${at}: casts to a verified actor; take actors from currentUser() / currentActor()`,
        );
      }
      if (/['"`]x-ga-(caller|principal)['"`]/.test(line)) {
        problems.push(
          `${at}: builds identity metadata by hand; the service kit sets it on every call`,
        );
      }
    });
  }
}

const listed = (JSON.parse(readFileSync(LIST, 'utf8')) as { endpoints: Entry[] }).endpoints;
const key = (entry: Entry) => `${entry.where} [${entry.access}] ${entry.reason}`;
const counts = (entries: readonly Entry[]) => {
  const map = new Map<string, number>();
  for (const entry of entries) map.set(entry.where, (map.get(entry.where) ?? 0) + 1);
  return map;
};
for (const [where, count] of counts(found)) {
  if (count > 1) problems.push(`${where}: ${count} access decorators open the same member`);
}
for (const [where, count] of counts(listed)) {
  if (count > 1) problems.push(`security/public-endpoints.json lists ${where} ${count} times`);
}
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
