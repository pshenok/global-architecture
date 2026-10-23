import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { expectListedOpenEndpoints, ownPackageDir } from './public-endpoints.ts';

const root = mkdtempSync(join(tmpdir(), 'ga-endpoints-'));
mkdirSync(join(root, 'security'));
writeFileSync(
  join(root, 'security/public-endpoints.json'),
  JSON.stringify({
    endpoints: [
      { where: 'apps/a-service/src/a.ts#A.get', access: 'public', reason: 'catalogue' },
      { where: 'apps/a-service/src/a.ts#A.list', access: 'public', reason: 'catalogue' },
      { where: 'apps/ab-service/src/b.ts#B.get', access: 'service', reason: 'workloads: c' },
    ],
  }),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = { member: 'A.get', access: 'public', reason: 'catalogue' } as const;
const list = { member: 'A.list', access: 'public', reason: 'catalogue' } as const;

describe('expectListedOpenEndpoints', () => {
  it('accepts exactly the listed endpoints of the package', () => {
    expect(() => expectListedOpenEndpoints('apps/a-service', [list, get], root)).not.toThrow();
    expect(() => expectListedOpenEndpoints('apps/other', [], root)).not.toThrow();
  });

  it('names an open endpoint the list does not have, a repeat included', () => {
    const wrapped = { member: 'A.remove', access: 'public', reason: 'catalogue' } as const;
    expect(() => expectListedOpenEndpoints('apps/a-service', [get, list, wrapped], root)).toThrow(
      'open but not listed: A.remove [public] catalogue',
    );
    expect(() => expectListedOpenEndpoints('apps/a-service', [get, list, get], root)).toThrow(
      'open but not listed: A.get [public] catalogue',
    );
  });

  it('names a listed endpoint that is no longer open, or open with another reason', () => {
    expect(() => expectListedOpenEndpoints('apps/a-service', [get], root)).toThrow(
      'listed but not open: A.list [public] catalogue',
    );
    expect(() =>
      expectListedOpenEndpoints('apps/a-service', [get, { ...list, reason: 'other' }], root),
    ).toThrow(/open but not listed: A.list \[public\] other\n {2}listed but not open: A.list/);
  });

  it('does not mix up packages that share a prefix', () => {
    expect(() => expectListedOpenEndpoints('apps/a', [], root)).not.toThrow();
    expect(() => expectListedOpenEndpoints('apps/ab-service', [], root)).toThrow(
      'listed but not open: B.get [service] workloads: c',
    );
  });

  it('checks a service only from its own package', () => {
    expect(ownPackageDir('service-kit')).toBeUndefined();
  });
});
