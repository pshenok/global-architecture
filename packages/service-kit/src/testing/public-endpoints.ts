import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** An endpoint callable without a signed-in user, read from the metadata an app carries. */
export interface DeclaredOpenEndpoint {
  /** `Class.method`, or `Class` for a decorator on the class. */
  readonly member: string;
  readonly access: 'public' | 'unregistered' | 'identity' | 'service';
  readonly reason: string;
}

interface ListedEndpoint {
  readonly where: string;
  readonly access: string;
  readonly reason: string;
}

const LIST = join('security', 'public-endpoints.json');

/** The repository root: the closest directory above `from` that has the list. */
function repositoryRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, LIST))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const describe = (entry: { access: string; reason: string }, member: string) =>
  `${member} [${entry.access}] ${entry.reason}`;

/**
 * Throws unless `declared` (what the app in `packageDir`, e.g. `apps/gateway`, really
 * carries) matches what security/public-endpoints.json lists for it. tools/check-access.ts
 * compares the same list with the source, where only direct decorators can be read; this
 * check sees the metadata itself, so a wrapper, an alias or a SetMetadata shows up here.
 */
export function expectListedOpenEndpoints(
  packageDir: string,
  declared: readonly DeclaredOpenEndpoint[],
  root = repositoryRoot(process.cwd()),
): void {
  if (!root) throw new Error(`${LIST} not found above ${process.cwd()}`);
  const prefix = `${packageDir.split(sep).join('/')}/`;
  const listed = (
    JSON.parse(readFileSync(join(root, LIST), 'utf8')) as { endpoints: ListedEndpoint[] }
  ).endpoints
    .filter((entry) => entry.where.startsWith(prefix))
    .map((entry) => describe(entry, entry.where.slice(entry.where.indexOf('#') + 1)))
    .sort();
  const actual = declared.map((entry) => describe(entry, entry.member)).sort();
  const missing = minus(actual, listed);
  const stale = minus(listed, actual);
  if (missing.length === 0 && stale.length === 0) return;
  throw new Error(
    [
      `${LIST} does not match what ${packageDir} declares at runtime (ADR-0004):`,
      ...missing.map((entry) => `  open but not listed: ${entry}`),
      ...stale.map((entry) => `  listed but not open: ${entry}`),
      'Declare access with a direct @Public / @Access.<kind> decorator and list it with the same reason.',
    ].join('\n'),
  );
}

/** Entries of `a` that `b` does not match one for one. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const unmatched = [...b];
  return a.filter((entry) => {
    const index = unmatched.indexOf(entry);
    if (index < 0) return true;
    unmatched.splice(index, 1);
    return false;
  });
}

/**
 * The package directory of a service when the current test runs in that service's own
 * package (`apps/<name>`), relative to the repository root; undefined otherwise (kit tests,
 * or another app's test starting a fake of this service).
 */
export function ownPackageDir(serviceName: string): string | undefined {
  const root = repositoryRoot(process.cwd());
  if (!root) return undefined;
  const dir = relative(root, process.cwd()).split(sep).join('/');
  return dir === `apps/${serviceName}` ? dir : undefined;
}
